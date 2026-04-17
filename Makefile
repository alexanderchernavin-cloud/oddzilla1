.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose

.PHONY: help up down logs ps restart build migrate seed psql redis-cli fmt lint test typecheck clean nuke

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Start the full stack (detached)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail all service logs
	$(COMPOSE) logs -f --tail=200

ps: ## Show container status
	$(COMPOSE) ps

restart: ## Restart all services
	$(COMPOSE) restart

build: ## Rebuild all images
	$(COMPOSE) build

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
