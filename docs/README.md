# docs/

| File | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, end-to-end data-flow walkthroughs (odds updates, bet placement, settlement, deposits, withdrawals), scale path, security boundaries, observability. |
| [SCHEMA.md](SCHEMA.md) | Every table explained, invariants, wallet-movement model table, common queries, migration workflow. |
| [ODDIN.md](ODDIN.md) | Oddin.gg protocol cheat sheet — AMQP routing keys, XML message types, REST endpoints, market IDs for CS2/DOTA2/LOL/Valorant, specifier canonicalization, recovery. |
| [PHASES.md](PHASES.md) | Phase roadmap with delivered detail per phase. **Phases 1–8 complete + post-Phase-8 hardening pass shipped.** News scraper cancelled mid-Phase-8 (migration 0003 dropped the table). Next layer is the pre-launch exit gates. |
| [OPERATIONS.md](OPERATIONS.md) | Deploy, env vars, health, logs, metrics, backups, restore, incident playbook, withdrawal admin runbook, HD mnemonic management. |
| [fixtures/specifiers.json](fixtures/specifiers.json) | Golden test fixture shared between TS + 2 Go specifier implementations. |

Entry points for different questions:

- **"How do I set up the repo?"** → [../README.md](../README.md).
- **"What rules must my code follow?"** → [../CLAUDE.md](../CLAUDE.md).
- **"How does X work?"** → ARCHITECTURE.md.
- **"What's in the database?"** → SCHEMA.md.
- **"How do I talk to Oddin?"** → ODDIN.md.
- **"What's next to build?"** → PHASES.md.
- **"Prod is on fire, what do I do?"** → OPERATIONS.md.
