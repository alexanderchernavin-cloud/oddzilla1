.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose

.PHONY: help up down logs weblogs ps restart build recreate recreate-web migrate seed psql redis-cli fmt lint test typecheck clean nuke deploy deploy-status rollback

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Start the full stack (detached)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail all service logs
	$(COMPOSE) logs -f --tail=200

weblogs: ## Tail interleaved logs from every Next.js replica (web1/web2/web3)
	$(COMPOSE) logs -f --tail=200 web1 web2 web3

ps: ## Show container status
	$(COMPOSE) ps

restart: ## Restart all services
	$(COMPOSE) restart

build: ## Rebuild one service image: make build SVC=api
	@if [ -z "$(SVC)" ]; then \
		echo "ERROR: Specify a service: make build SVC=api"; \
		echo "For a full deploy, use 'make deploy' (parallel builds + migrations + smoke)."; \
		exit 1; \
	fi
	$(COMPOSE) -f docker-compose.yml build $(SVC)

recreate: ## Recreate one service: make recreate SVC=api
	@if [ -z "$(SVC)" ]; then \
		echo "ERROR: Specify a service: make recreate SVC=api"; \
		exit 1; \
	fi
	$(COMPOSE) -f docker-compose.yml up -d --no-deps --force-recreate $(SVC)

recreate-web: ## Rolling-recreate web1 → web2 → web3 (waits for each to pass healthcheck)
	@for r in web1 web2 web3; do \
		echo "→ recreating $$r"; \
		$(COMPOSE) -f docker-compose.yml --profile scaled up -d --no-deps --force-recreate $$r; \
		for i in 1 2 3 4 5 6 7 8 9 10 11 12; do \
			state=$$(docker inspect -f '{{.State.Health.Status}}' oddzilla-$$r 2>/dev/null || echo "missing"); \
			if [ "$$state" = "healthy" ]; then \
				echo "  $$r healthy"; break; \
			fi; \
			sleep 2; \
		done; \
	done

migrate: ## Apply database migrations
	pnpm --filter @oddzilla/db db:migrate

seed: ## Seed sports, dummy categories, admin + test users
	pnpm --filter @oddzilla/db db:seed

psql: ## Open psql shell on the running postgres container
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-oddzilla} -d $${POSTGRES_DB:-oddzilla}

redis-cli: ## Open redis-cli on the running redis container
	$(COMPOSE) exec redis redis-cli

fmt: ## Format all code (prettier + gofmt)
	pnpm format
	@for svc in feed-ingester odds-publisher settlement bet-delay wallet-watcher; do \
		cd services/$$svc && gofmt -w . && cd ../..; \
	done

lint: ## Lint TS + Go
	pnpm lint
	@for svc in feed-ingester odds-publisher settlement bet-delay wallet-watcher; do \
		cd services/$$svc && go vet ./... && cd ../..; \
	done

typecheck: ## TypeScript strict check across workspaces
	pnpm typecheck

test: ## Run TS + Go tests
	pnpm test
	@for svc in feed-ingester odds-publisher settlement bet-delay wallet-watcher; do \
		cd services/$$svc && go test ./... && cd ../..; \
	done

clean: ## Remove build artifacts (keeps docker volumes)
	rm -rf **/.turbo **/dist **/.next **/node_modules/.cache

nuke: ## Full reset — stops stack AND removes volumes (DESTROYS database)
	$(COMPOSE) down -v

# ── Production deploy ──────────────────────────────────────────────
# These targets are intended to be invoked on the production box
# (`team@178.104.174.24:/home/team/oddzilla`). They wrap the scripts
# under infra/deploy/ which do the actual orchestration (lock, diff,
# pre-deploy backup, build, recreate, smoke, log).
#
# Running them locally is harmless (status is read-only; deploy will
# bail out without docker/sudo) but the smoke + recreate steps only
# make sense on the server.

deploy: ## Run a full deploy: fetch → diff → backup → migrate → build → recreate → smoke
	@bash infra/deploy/deploy.sh

deploy-status: ## Show what 'make deploy' would do (no side effects)
	@bash infra/deploy/status.sh

rollback: ## Roll containers back to the previous deploy (does NOT revert migrations)
	@bash infra/deploy/rollback.sh
