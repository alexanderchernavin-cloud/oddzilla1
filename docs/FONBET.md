# Fonbet KZ line — second odds provider

`services/fonbet-ingester` scrapes the public Fonbet Kazakhstan line to put
traditional sports (football, tennis, hockey, basketball, …) next to
Oddin's esports. This page is the protocol + mapping cheat sheet; the
service README covers the code layout.

Verified against the live site on 2026-09-03. Fonbet has no public API
contract — everything below is observed behaviour and can change without
notice. The ingester is defensive (unknown factors are skipped, hosts
rotate, staleness suspends), but treat a sudden drop in
`/healthz` `matches` as a mapping break, not as an empty line.

## Endpoints

| Step             | Request                                                            | Notes                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host discovery   | `GET https://fonbet.kz/urls.json`                                  | `line[]` = `//lineNN-w.kzac51-resources.kz` hosts (rotate; fallback list in `FONBET_LINE_HOSTS`). `common[]` are account hosts — unused.                                |
| Full line        | `GET <line>/events/list?lang=ru&version=0&scopeMarket=1800`        | ~1.2 MB JSON, gzip-encoded even without `Accept-Encoding`. **`scopeMarket` must be 1800** for the KZ hosts (the RU site's 1600 → `404 Not Found`). `lang` ∈ ru, en, kk. |
| Factor catalogue | `GET <line>/line/factorsCatalog/tables?version=0&lang=ru&sysId=NN` | Market layouts + labels. `sysId` = the host number (`line05` → 5). Covers 100 % of the factors seen in the line.                                                        |
| Live only        | `GET <line>/line/liveEvents?lang=ru`                               | Not used (the full snapshot already carries live).                                                                                                                      |
| Deltas           | `events/list?version=<packetVersion>`                              | Returns partial `customFactors` (only changed factors, no removal markers) — not safe for a full-snapshot model, so the ingester always refetches `version=0`.          |

Headers sent: browser-like `User-Agent`, `Origin: https://fonbet.kz`,
`Referer: https://fonbet.kz/`. No cookies, no auth.

## `events/list` shape (fields we read)

```
packetVersion        int64   monotonic snapshot id
sports[]             {id, parentId?, kind: "sport"|"segment", name, alias?, regionId}
                     kind=sport && !parentId → root sport (Футбол=1, Теннис=4,
                     Хоккей=2, Баскетбол=3, Киберспорт=29086 …)
                     kind=segment → league, parentId = root
events[]             {id, parentId?, level, sportId (segment), kind, team1, team2,
                      team1Id, team2Id, name, startTime (unix s), place}
                     level 1 = match; level 2/3 = sub-event on parentId:
                       kind 100201/100202 halves, 400100 corners, 102001.. maps,
                       91 player props (player name in team1, name empty)
                     place: line (prematch) | live | notActive
customFactors[]      {e: eventId, factors: [{f, v, p?, pt?}]}
                     f = factor id, v = decimal odds, p = param×100, pt = param text
                     ("-2.5", "+2.5", "2.5"); factors are the FULL current offer
eventBlocks[]        {eventId, state: "blocked" | "partial", factors?[]}
eventMiscs[]         {id, score1, score2, comment, timerSeconds, timerDirection}
liveEventInfos[]     {eventId, finished, timer, scores[[{c1,c2,title}]], scoreComment}
```

## `factorsCatalog/tables` shape

```
groups[] { name, tables[] { num, name, isMain, sortByParam, rows[][] } }
rows[0]     header captions ({name})               e.g. ["1","X","2","1X","12","X2"]
rows[1..]   cells: {name} text | {kind:"param", factorId} line value |
                   {kind:"value", factorId} priced factor
```

- One table = one market layout, one data row = one line of it.
- `param` cells per row: 2 → handicap (side 1 gets −x, side 2 +x),
  1 → total / threshold, 0 → plain market.
- Group `%1` / `%2` = per-team tables (rendered with `{side}`).
- Table `num` is unique across the catalogue (580 tables, ru and en share
  the same nums).

## Mapping into the oddzilla schema

| Fonbet              | oddzilla                                                                     | Rule                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root sport          | `sports` (`provider='fonbet'`, `provider_urn='fb:sport:<id>'`)               | slug + English name from `internal/mapper/sports.go`; unknown roots → `fb-<id>`; `kind='traditional'` (esports root → `esport`)                                     |
| segment name prefix | `categories` (`(sport_id, slug)`)                                            | `"Испания. Примера дивизион"` → category `Испания`; single-segment names → `Other`                                                                                  |
| segment             | `tournaments` (`provider_urn='fb:tournament:<id>'`)                          | slug = slugified name + `-<id>`                                                                                                                                     |
| team                | `competitors` (`provider='fonbet'`, `provider_urn='fb:competitor:<teamId>'`) | slug = slugified name + `-<teamId>`                                                                                                                                 |
| level-1 event       | `matches` (`provider_urn='fb:match:<eventId>'`)                              | `place=live` → `live`, `line` → `not_started`; `finished` or a live match that vanished → `closed`; events without two teams (outrights) skipped                    |
| catalogue table     | `markets.provider_market_id = 1_000_000 + num`                               | double-chance cells of a match-winner table are split off to `1_900_000 + num`                                                                                      |
| line                | `specifiers.handicap` / `specifiers.threshold`                               | value = side-1 `pt` normalised (`+2.5` → `2.5`, `-0` → `0`); both sides of one row share the market                                                                 |
| sub-event           | `specifiers.variant = "fb:<kind>[:<team1Id>]"`                               | esports maps (`1-я карта`) → `specifiers.map = N` instead                                                                                                           |
| per-team table      | `specifiers.side = home / away`                                              | template `{side}: Тотал {threshold}` renders the team name                                                                                                          |
| factor              | `market_outcomes.outcome_id = <factorId>`                                    | match-winner tables use `1` (home) / `2` (away) / `3` (draw) so `loadMatchWinnerOdds` pairs them like Oddin's                                                       |
| blocked event       | `markets.status = -1`, outcomes `active=false`                               | partial blocks flip only the listed factors inactive                                                                                                                |
| labels              | `market_descriptions` / `outcome_descriptions`                               | written on boot from the catalogue in `FONBET_LANG` and `en`; variant rows (`"1-й тайм: Фора {handicap}"`) written lazily the first time a sub-event market is seen |

`provider_market_id ≥ 1_000_000` is the Fonbet namespace: `odds_config`
`market_type` scopes, `fe_market_display_order` and `fe_market_groups`
address Fonbet markets with these ids.

## Operating notes

- **Volume.** Full line ≈ 5.8k matches, 65k markets, 200k outcomes. The
  first cycle on an empty database writes all of it; afterwards a cycle
  touches only what moved (typically a few hundred outcomes per 5 s).
  Scope it with `FONBET_ALLOWED_SPORT_IDS` / `FONBET_MAX_MATCHES` on small
  boxes.
- **Boot.** Previous state is loaded from Postgres so restarts do not
  republish unchanged prices onto `odds.raw` (which is trimmed at ~100k
  entries).
- **Staleness.** No snapshot for `FONBET_STALE_SUSPEND_SECONDS` → every
  active Fonbet market goes `-1` with odds nulled; the next good snapshot
  re-activates whatever is still quoted. SIGTERM does the same so a
  stopped container never leaves stale prices bettable.
- **Esports.** Root 29086 is blocked by default — Oddin already covers
  it and two providers for one match would double-list it.
- **Geo.** The KZ hosts answered from the Hetzner box's region in testing;
  if Fonbet geo-blocks the datacentre, `/healthz` shows a growing
  `snapshotStaleSeconds` and the watchdog suspends the catalog.

## Not done yet: settlement

Fonbet pushes no results. `services/settlement` only understands Oddin
AMQP messages, so Fonbet markets never reach `-3` and tickets on them stay
`accepted` forever. Options, in order of effort:

1. Score-based resolution for the main markets (1X2, double chance,
   handicap, total) from the final `liveEventInfos.scores` when a match
   flips to `closed` — covers most of the handle, exact rules per sport.
2. Fonbet's results endpoint (the site's `desktop.results` chunk loads a
   separate results API) — enumerate, decode, map factor → won/lost.
3. Manual admin settlement UI as the escape hatch.

Whichever lands must reuse the apply-once `settlements` keying
(`event_urn, market_id, specifiers_hash, type, payload_hash`) and the
sticky `-3 / -4` invariant. **Until then keep `FONBET_ENABLED=false` on
production.**
