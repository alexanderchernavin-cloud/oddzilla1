# Fonbet line — second odds provider

`services/fonbet-ingester` scrapes the public Fonbet line to put
traditional sports (football, tennis, hockey, basketball, …) next to
Oddin's esports. This page is the protocol + mapping cheat sheet; the
service README covers the code layout.

## Which site, which language

**`fon.bet`, in English** (defaults since 2026-09-04; the service read the
Kazakhstan site `fonbet.kz` in Russian before that). Moving sites means
moving a matched set of env vars, because `scopeMarket`, the request
`Origin` and the asset CDN are all per site:

| Site        | `FONBET_SITE_ORIGIN`   | `FONBET_URLS_JSON`             | `FONBET_SCOPE_MARKET` | `FONBET_LOGO_CDN`                   |
| ----------- | ---------------------- | ------------------------------ | --------------------- | ----------------------------------- |
| fon.bet     | `https://fon.bet`      | `https://fon.bet/urls.json`    | `1600`                | `https://cdn-ec.bk6bba-resources.com` |
| fonbet.kz   | `https://fonbet.kz`    | `https://fonbet.kz/urls.json`  | `1800`                | `https://cdn-cf.kzac51-resources.kz` |

Crossing them fails loudly rather than silently: the KZ hosts answer
`404` to `scopeMarket=1600` and vice versa. `FONBET_LINE_HOSTS` /
`FONBET_COMMON_HOSTS` must be moved with the site too — they are also the
trust anchor for `urls.json` discovery (a host is adopted only if its
registrable domain matches one of the configured ones), so leaving the KZ
lists in place while pointing `FONBET_URLS_JSON` at fon.bet makes every
discovered host get rejected.

**The two sites are the same line.** Measured 2026-09-04, English,
scopeMarket paired per site: 13 303 of ~13 380 events shared by id
(the rest is a minute of line movement between the two fetches), the same
965-node sports tree with the same 32 root sport ids, and byte-identical
catalogues — 580 tables with the same numbers and names, and identical
`IsMatchWinner` / param-kind / outcome-id derivation for every factor. So
switching sites (or languages) changes **no** market or outcome identity:
`provider_market_id`, `outcome_id` and `specifiers_hash` are unaffected
and existing tickets keep resolving. Only display text moves.

**Language is not display-only.** `FONBET_LANG` picks the language of the
snapshot (team, tournament and sub-event names), of the factor catalogue
(market and outcome labels) and of the results feed (`locale`), and the
settlement grader reads all three — see "Settlement → language". The
grader carries an **English vocabulary only** (the Russian one that served
the `fonbet.kz` era was removed on 2026-09-06), so `config.Load` refuses
any `FONBET_LANG` but `en`. `market_descriptions` rows are still written
for every other locale in `descriptionLangs` (ru), so the storefront's
`/ru` shows Russian market names off the English feed — display data the
grader never reads.

Verified against the live site on 2026-09-04 (2026-09-03 for the parts not
touched by the fon.bet switch). Fonbet has no public API
contract — everything below is observed behaviour and can change without
notice. The ingester is defensive (unknown factors are skipped, hosts
rotate, staleness suspends), but treat a sudden drop in
`/healthz` `matches` as a mapping break, not as an empty line.

## Endpoints

| Step             | Request                                                            | Notes                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host discovery   | `GET https://fon.bet/urls.json`                                    | `line[]` = `//line-lbNN.bk6bba-resources.{com,ru}` hosts (rotate; fallback list in `FONBET_LINE_HOSTS`). `common[]` = clientsapi hosts (results feed; fallback `FONBET_COMMON_HOSTS`). **Trust filter:** a discovered host is adopted only if it is `https` (or scheme-relative `//`) AND its registrable domain matches one of the operator-configured hosts / `FONBET_URLS_JSON`; anything else is logged and ignored, the static lists stay in force. The document is third-party network input that sets where we fetch prices and results from, so it must not be able to downgrade us to plaintext or point us at an arbitrary or internal origin. A genuine Fonbet domain move shows up as the skipped-hosts warning and needs the env lists updated. |
| Full line        | `GET <line>/events/list?lang=en&version=0&scopeMarket=1600`        | ~1.4 MB JSON, gzip-encoded even without `Accept-Encoding`. **`scopeMarket` is per site**: 1600 on fon.bet, 1800 on fonbet.kz, and each 404s on the other's value. `lang` ∈ en, ru, kk. |
| Factor catalogue | `GET <line>/line/factorsCatalog/tables?version=0&lang=en&sysId=NN` | Market layouts + labels. `sysId` = the host number (`line05` → 5); the fon.bet hosts carry no number and ignore it. Covers 100 % of the factors seen in the line.       |
| Logo catalogue   | `POST <line>/line/logos`                                           | Body `{lang, sysId, teams:"actual", competitions:"actual", sportKinds:"actual"}`. Team crests (PNG), competition marks (PNG + SVG) and sport glyphs, as paths under `FONBET_LOGO_CDN`. `competitions` is keyed by **segment id**, so it joins straight onto `fb:tournament:<id>`. `"actual"` covers what is currently on the line; `"all"` returns 125 593 mappings instead of 767 but adds **nothing** for us — every id we hold is already in the `"actual"`-scoped answer, just often as the literal value `"none"` (measured 2026-09-05). |
| Live only        | `GET <line>/line/liveEvents?lang=en`                               | Not used (the full snapshot already carries live).                                                                                                                      |
| Deltas           | `events/list?version=<packetVersion>`                              | Returns partial `customFactors` (only changed factors, no removal markers) — not safe for a full-snapshot model, so the ingester always refetches `version=0`.          |

Headers sent: browser-like `User-Agent`, `Origin` + `Referer` for
`FONBET_SITE_ORIGIN` (`https://fon.bet` by default). No cookies, no auth.

`internal/fonbet/livesmoke_test.go` exercises this whole surface against
the configured site with no database — host discovery, the snapshot, both
catalogues, the logo catalogue and one day of results:

```bash
cd services/fonbet-ingester && go test -tags livesmoke ./internal/fonbet/ -run TestLiveSmoke -v
```

## `events/list` shape (fields we read)

```
packetVersion        int64   monotonic snapshot id
sports[]             {id, parentId?, kind: "sport"|"segment", name, alias?,
                      regionId, tournamentInfoId?}
                     kind=sport && !parentId → root sport (ids are stable
                     across sites and languages: Football=1, Tennis=4,
                     Ice Hockey=2, Basketball=3, Esports=29086 …)
                     kind=segment → league, parentId = root
                     tournamentInfoId → tournamentInfos[] (competition mark)
tournamentInfos[]    {id, icon?, caption, …} — per-competition metadata.
                     Only `icon` is read, and it is the SECOND source of
                     tournament marks: a path in a different asset tree
                     (/Logotypes/Tournament/) from the one line/logos
                     serves (/Logotypes/CompetitionLogos/). Neither is a
                     superset. See "Tournament marks" below.
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
- An outcome's label is `<row caption> <column caption>` (e.g. `goals Over`,
  or just `Over` when the row carries only the line). The **total columns
  are captioned with one letter** — `O` / `U` in English, `Б` / `М` in
  Russian — which reads fine above Fonbet's own line column but IS the
  whole label once the storefront renders each cell on its own row, so
  `captionWord` expands those two to words (`Over` / `Under`,
  `Больше` / `Меньше`) as the label is built. Measured on the live
  catalogue: 363 bare over + 363 bare under captions per language, and the
  only short captions left unexpanded are the handicap sides `1` / `2`.
  Display-only — the grader keys totals off the `over` / `under` side id
  (`sideCaptions`), never off the label, and both lists are keyed by that
  same side id so they cannot drift.

## Mapping into the oddzilla schema

| Fonbet              | oddzilla                                                                                                                                   | Rule                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root sport          | `sports` (`provider='fonbet'`, `provider_urn='fb:sport:<id>'`)                                                                             | slug + English name from `internal/mapper/sports.go`; unknown roots → `fb-<id>`; `kind='traditional'` (esports root → `esport`)                                     |
| segment name prefix | `categories` (`(sport_id, slug)`)                                                                                                          | `"Spain. Primera Division. Season 26/27"` → category `Spain`; single-segment names → `Other`                                                                                  |
| segment             | `tournaments` (`provider_urn='fb:tournament:<id>'`)                                                                                        | slug = slugified name + `-<id>`                                                                                                                                     |
| team                | `competitors` (`provider='fonbet'`, `provider_urn='fb:competitor:<teamId>'`)                                                               | slug = slugified name + `-<teamId>`                                                                                                                                 |
| level-1 event       | `matches` (`provider_urn='fb:match:<eventId>'`)                                                                                            | `place=live` → `live`, `line` → `not_started`; `finished` or a live match that vanished → `closed`; events without two teams (outrights) skipped                    |
| catalogue table     | `markets.provider_market_id = 1_000_000 + num`                                                                                             | double-chance cells of a match-winner table are split off to `1_900_000 + num`                                                                                      |
| line                | `specifiers.handicap` / `specifiers.threshold`                                                                                             | value = side-1 `pt` normalised (`+2.5` → `2.5`, `-0` → `0`); both sides of one row share the market                                                                 |
| sub-event           | `specifiers.variant = "fb:<kind>[/<childKind>][:<team1Id>]"` (nested children inherit the parent: "1st half corners" → `fb:100201/400100`) | esports maps (`1st map`) → `specifiers.map = N` instead                                                                                                           |
| per-team table      | `specifiers.side = home / away`                                                                                                            | template `{side}: Тотал {threshold}` renders the team name                                                                                                          |
| factor              | `market_outcomes.outcome_id = <factorId>`                                                                                                  | match-winner tables use `1` (home) / `2` (away) / `3` (draw) so `loadMatchWinnerOdds` pairs them like Oddin's                                                       |
| blocked event       | `markets.status = -1`, outcomes `active=false`                                                                                             | partial blocks flip only the listed factors inactive                                                                                                                |
| labels              | `market_descriptions` / `outcome_descriptions`                                                                                             | written on boot from the catalogue in `FONBET_LANG` plus every other locale in `descriptionLangs` (en, ru); variant rows (`"1st half: Handicap {handicap}"`) written lazily the first time a sub-event market is seen. The sub-event half of a variant row is always in the FEED language — it comes from the snapshot, which is fetched once — so a `ru` row off an English feed reads "1st half: Фора {handicap}" |
| per-team table (by number) | market NAME carries the team | Fonbet numbers the sides instead of naming them — `Team 1 totals {threshold}` / `Инд. тоталы-1`, `Team Totals-1`, `1 to win` / `Победа 1`, and a couple of captions where its `%1` / `%2` placeholder leaks into the name. `applyTeamNumberLabel` (services/api/src/lib/market-naming.ts) swaps the number for the team at render time — 1 is home, 2 is away, the same convention the factor ids use — so the storefront and the bet slip read "Swansea totals 2.5". Market names only: outcome captions keep the number, since the header above them already names the team. |

`provider_market_id ≥ 1_000_000` is the Fonbet namespace: `odds_config`
`market_type` scopes, `fe_market_display_order` and `fe_market_groups`
address Fonbet markets with these ids.

A sub-event is also a TAB on the match-detail page: the storefront groups
markets by `variant`, taking the tab title from the description prefix
("1st half corners: Match result" → **1st half corners**), and every
per-player variant collapses into one **Players** tab. Since migration
0106 those tabs are addressable as `fb_<kinds>` scopes
(`fb:400100/10100201` → `fb_400100_10100201`), so the backoffice at
`/admin/fe-settings/markets-order` orders the markets inside each and
reorders the tabs themselves. It discovers them by re-deriving the same
scopes over the sport's current offer — nothing stores the tab set — so a
sub-event Fonbet adds shows up there on its own, and one it drops stops
being offered (an ordering already saved for it survives).

## Operating notes

- **Volume.** Full line ≈ 5.8k matches, 65k markets, 200k outcomes. The
  first cycle on an empty database writes all of it; afterwards a cycle
  touches only what moved (typically a few hundred outcomes per 5 s).
  Scope it with `FONBET_ALLOWED_SPORT_IDS` / `FONBET_MAX_MATCHES` on small
  boxes. With a cap set, the shrink guard still compares the PRE-cap count
  (`Snapshot.TotalMatches`) and events cut by the cap are never treated as
  vanished (`Snapshot.Capped`) — a prematch event going live and pushing
  another past the cap must not deactivate the other.
- **Memory.** The service holds the whole line in RAM as the previous
  snapshot AND decodes + maps a fresh full snapshot every 5 s, so its
  working set is a multiple of the other Go workers'. Compose gives it
  `mem_limit: 768m` / `cpus: 1.0` / `GOMEMLIMIT=640MiB` (the anchor's 320m
  was only ever run on a workstation with no cgroup). An OOM-kill is
  SIGKILL — the SIGTERM suspend does not run and frozen prices stay
  bettable until the replacement finishes its first cycle — so check
  `docker stats` after enabling and tune the two values together.
- **`odds_history`.** Every published tick is an `odds_history` INSERT.
  The partition retention (`ODDS_RETENTION_DAYS`, default 35) was sized
  for Oddin's few hundred ticks/s; watch partition sizes for the first
  24 h after enabling and either shorten the window or set
  `ODDS_HISTORY_SKIP_PMID_MIN=1000000` on odds-publisher to stop writing
  history for the Fonbet namespace. See docs/OPERATIONS.md "odds_history
  retention".
- **Switch.** The feed is turned on and off from the **Fonbet feed** card
  on `/admin/feed` (`PUT /admin/feed/fonbet`, migration 0099), no
  container restart. The position lives in `feed_control.fonbet_enabled`
  (Postgres, not Redis — see 0095 for why) and wins over `FONBET_ENABLED`
  once set; the env var is only the default while the column is NULL.
  fonbet-ingester reads it every 2 s: **Off** runs `SuspendAll` (every
  Fonbet market to `-1`, prices kept, so nothing is listed or bettable),
  stops polling Fonbet and stops the settlement worker — tickets on Fonbet
  markets stay open until the feed is on again or settled by hand;
  **On** boots the feed in place (catalogue, previous state from pg,
  workers) and the first cycle re-activates whatever Fonbet still quotes.
  A boot failure while On (Fonbet unreachable) retries every 30 s rather
  than crashing the container. The ingester acknowledges what it applied
  in `fonbet_applied_*` and publishes live counters to the Redis hash
  `fonbet:feed:status` (5 s refresh, 120 s TTL) so the card can tell
  "service offline" from "feed switched off".
- **Boot.** Previous state is loaded from Postgres so restarts do not
  republish unchanged prices onto `odds.raw` (which is trimmed at ~100k
  entries).
- **Staleness.** No snapshot for `FONBET_STALE_SUSPEND_SECONDS` → every
  active Fonbet market goes `-1` (prices are kept, placement rejects
  `market_not_active`); the next good snapshot re-activates whatever is
  still quoted with status flips only, so a restart never re-emits the
  whole line onto `odds.raw`. SIGTERM does the same so a stopped container
  never leaves stale prices bettable.
- **`odds.raw` cap + backpressure.** Both ingesters trim `odds.raw` to the
  SAME 100k MAXLEN (Redis applies whichever XADD runs, so the values must
  agree). The cold-start republish (~200k prices) is paced, not buffered:
  before each 1000-entry chunk the ingester reads odds-publisher's consumer
  group lag (`XINFO GROUPS`, group `ODDS_PUBLISHER_GROUP`) and waits while
  it is above 50k, for at most 60 s per flush. Do NOT raise the cap to make
  the burst fit — production Redis is `maxmemory 256mb` + `allkeys-lru`,
  and the first cut's 400k was half of that on its own; a stream that
  outgrows the budget evicts unrelated keys and destroys consumer groups
  (the 2026-09-03 incident). `settlement.external` is capped at 20k.
- **Esports.** Root 29086 is blocked by default — Oddin already covers
  it and two providers for one match would double-list it.
- **The other provider can suspend this one.** Fonbet writes the same
  `markets` / `market_outcomes` / `matches` tables as the Oddin feed, so a
  catalog-wide suspend on either side must be scoped by
  `matches.provider_urn` (CLAUDE.md invariant 10). It was not, until
  2026-09-04: an Oddin credential failure tripped the alive watchdog,
  whose flush matched on match status alone, and ~104 000 Fonbet markets
  were suspended with their prices nulled while Oddin's own offer stayed
  up on the backup feed. Both copies of that flush are scoped now, and
  `Ingester.ReconcileExternalSuspend` is the backstop: this service only
  writes what changed against an in-memory picture of its own writes, so a
  foreign write is otherwise invisible to it and the offer stays dark
  until a restart. One `COUNT` a minute; when the DB holds under half the
  markets we believe are active, the flip is mirrored in memory and the
  next cycle re-asserts everything Fonbet still quotes.
- **Geo.** The hosts answered from the Hetzner box's region in testing;
  if Fonbet geo-blocks the datacentre, `/healthz` shows a growing
  `snapshotStaleSeconds` and the watchdog suspends the catalog. Both
  estates are worth trying if one is blocked — they serve the same line.

## Settlement

Fonbet pushes no settlement feed, so `fonbet-ingester` grades its own
markets from the results feed and hands the results to
`services/settlement`, which applies them exactly like an Oddin
`bet_settlement` (apply-once `settlements` row, sticky `-3` / `-4`,
outcome cascade, ticket grading for every bet type, wallet payouts, WS
frames, all-terminal match close).

| Step                               | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Results source                     | `GET <common>/results/results.json.php?locale=<FONBET_LANG>&lineDate=YYYY-MM-DD` on the `common` (clientsapi) hosts. `events[]` carry `name` ("A – B"), `score` ("2:2 (1-0 1-1 0-1 1-0)" — headline is the **main-time** score, periods in brackets), `startTime`, `status` (3 finished, 4 cancelled); `sections[]` map `fonbetCompetitionId` (= our segment / tournament id) to result rows. Statistic rows ("Corners", "Yellow cards", "aces", "extra time", "penalty shootouts" — "угловые", "желтые карты", "эйсы", "дополнительное время", "серия пенальти" under `locale=ru`) follow their match with the same `startTime`. One document covers one **UTC+3 (Moscow) calendar day** — measured on both estates 2026-09-04, `lineDate=2026-09-03` spans startTimes 2026-09-02 21:00 UTC to 2026-09-03 20:59 UTC — and the worker fetches each pending match's day plus the previous one, so the boundary is a margin rather than a cliff. Result ids are document-local, so matching is by (competition, startTime, normalised "home – away"). Exact name first; the fallback accepts a row that contains both names **home before away** (sponsor / city decoration) and rejects the mirrored row — an order-blind substring match bound "Рубин – Оренбург" to home=Оренбург and inverted every grade on the match. A fixture the two feeds order differently therefore stays pending for manual settlement. One more fallback, narrow on purpose (2026-09-06): fixtures created while the line was read from `fonbet.kz` hold **Cyrillic** team names the English results feed can never spell, so 606 of them sat unmatched with 33 630 open markets; for those only, the (competition, start time) key stands in when it is unambiguous on BOTH sides — exactly one results row at the key and exactly one fixture of ours in that tournament at that kick-off (`PendingMatch.SameSlot`). Measured against the misses table before shipping: 290 fixtures / 19 398 markets resolve, every sampled pair correct (Япония – Оман ↔ Japan – Oman); the rest have no row at the key (postponed / absent) or a same-time neighbour and stay pending. Latin-named mismatches never take this path.                                                                                                                                                  |
| Worker                             | `internal/settle` in fonbet-ingester — every `FONBET_SETTLE_INTERVAL_MS`: `store.LoadPendingSettlement` (closed `fb:` matches with non-terminal markets, last 7 days) → results for the involved line days → `Grade` per market → `XADD settlement.external`. Cancelled results (`status 4`) void every market of the match. **Gated by `FONBET_SETTLE_ENABLED`, default `false` — separate from `FONBET_ENABLED`** (see "Before enabling settlement"). A market is remembered as emitted only after its message is confirmed on the stream (per 500-message chunk); a failed XADD returns the error and the next pass retries everything unsent, instead of hiding the whole pass for an hour.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Rules (`internal/settle/rules.go`) | match winner 1/2/3 · double chance · the plain two-way "To win the match" table (491, not flagged main by Fonbet — recognised by shape) · both teams to score (2800, the nameless table) · handicap `h1/h2` · total `over/under` (whole, half and quarter lines, team totals via `side`) · the same on halves / periods / sets and on statistic rows. Sports: football, futsal, handball, bandy, hockey, floorball, water polo, rugby, beach soccer (headline = main time), basketball / 3x3 / american football / baseball (two-way markets add the "extra time" row), australian football (four quarters, "1st half" = quarters 1+2, regular time), tennis / table tennis / volleyball / badminton / beach volleyball / padel (winner by sets; handicaps and totals on games / points unless the table says "set"), darts (headline is legs; a section not saying "legs" — set play — is refused), MMA / boxing (fight sports: the results feed scores a bout "<round>:0" / "0:<round>", so the winner is the non-zero side and total rounds settle off the finishing round when that round decides the line; a finish IN the deciding round, a "0:0" and any handicap are refused). Tables whose name mentions overtime / shootout / penalt… / odd / even / exact / correct / series and every other sport or market shape are **left open** for the operator and counted in the `settlement pass` log line (`skipped`). The rules for australian football, bandy, beach soccer, padel, MMA, boxing and darts were added 2026-09-06 as the operator's temporary rules — the industry-standard conventions for the few shapes Fonbet quotes on them, read off the 09-04 / 09-05 results documents. |
| Consumer                           | `services/settlement/internal/extstream` — XREADGROUP on `settlement.external` (group `settlement`), builds an `oddinxml.Market` and calls `Settler.ApplyExternalSettlement` / `ApplyExternalCancel`. Failures stay pending and are re-claimed after 60 s (cursor-paginated, so a backlog larger than one batch drains in one tick). The group is created from `0`, not `$`, and is **recreated inline on `NOGROUP`** (CLAUDE.md invariant 7): production Redis is allkeys-lru and can evict the stream key, which destroys the group — without the branch no Fonbet market would settle again until a manual restart, and a restart creating the group at `$` would skip every message published in the gap. Stream capped at 20k entries (~6 MB). `SETTLEMENT_EXTERNAL_STREAM` (default `settlement.external`, empty disables).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Message                            | `type` settle\|cancel, `event_urn`, `provider_market_id`, `specifiers` (canonical, sorted), `ts` ms, `outcomes` JSON `[{id,result,void_factor}]` — result `1`/`0`, void_factor `1` void, `0.5` half. Specifiers and outcome order feed the apply-once payload hash, so a resend of the same grading is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Language

The grader reads the catalogue, the sub-event labels and the results feed
in `FONBET_LANG`, and `rules.go` carries an **English vocabulary only**.
While the line came from `fonbet.kz` it carried Russian as well; that
vocabulary was removed on 2026-09-06 (operator decision — the estate moved
to `fon.bet` in English on 2026-09-04 and is not going back), and
`config.Load` now refuses any other language rather than let the grader
run blind. What the vocabulary covers:

- **Refused table names** — overtime / shootout / penalt… / odd / even /
  exact / correct / series / minute. A threshold table called "Total
  missed penalties" looks exactly like an ordinary over/under to the shape
  checks, so the name guard is the only thing between it and a settlement
  off the goal score. Pinned by `TestTableUnsafeEnglish`.
- **Period labels** — English puts the marker at either end ("1st half
  corners" but "Yellow cards — 1st half"), so both positions are parsed.
  Units are only what the line emits: half, period, set, quarter, inning,
  map. Plural "innings" is excluded on purpose — Fonbet uses it for a
  cumulative "first N innings" row, not the Nth one.
- **"Nth half" is ambiguous.** One period of a two-half game and two
  quarters of a four-quarter one are both "1st half". `resolveHalf`
  decides per sport (`sportRule.half`): football / futsal / handball /
  rugby / bandy → period N, basketball / american football / australian
  football → periods 2N-1 + 2N. Any other sport **refuses** the label
  (`ambiguous half label`) instead of guessing.
- **Aggregate specials stay out of scope.** "8 matches 1st half", "Red
  card in the 1st half" and "Match to be finished in tie-break of 5th set"
  do parse a period, but the leftover text becomes a statistic name that
  the results feed does not carry, so `scoreFor` reports no score and the
  market stays open.
- **Tie-break rows** are "extra time" and "penalty shootouts" (football
  and hockey both file the shootout under that name).

One known naming gap: football's "hit the woodwork" — Fonbet's line calls
the sub-event "1st half hit the woodwork" while its results feed spells
the row "To hit the woodwork", so those events stay open for the operator.
Deliberately not papered over with fuzzy matching — on a payout path a
missed row costs an operator decision, a wrong match costs money.

Two-way markets tied after main time (hockey without an OT row, basketball
without the OT row) stay open rather than guess. For sports whose two-way
markets include overtime (basketball, american football, baseball) the OT
row is folded into the score exactly once — `scoreFor` reports it applied
and `breakTie` then consults only the shootout row — so a game still level
after the recorded overtime stays open instead of gaining an invented
winner. A market the rules skip can be settled by the operator; the
settlement service's reconcile sweeper then pays the tickets.

### Before enabling settlement

`FONBET_SETTLE_ENABLED` defaults to `false` and is gated separately from
`FONBET_ENABLED` on purpose: the grader moves real money through the same
apply-once path as Oddin settlements, and its rules have only been checked
by hand against a handful of matches. Order of operations on prod:

1. Turn the feed **On** from the Fonbet feed card on `/admin/feed` (or
   set `FONBET_ENABLED=true` as the env default) with
   `FONBET_SETTLE_ENABLED=false` — the line is live, Fonbet markets stay
   open after the final whistle, tickets sit `accepted`. The card's Off
   button is the emergency brake at any point: one click suspends every
   Fonbet market within 2 s. Watch `fonbet-ingester` `/healthz` (staleness, match count),
   `docker stats` for the 768m limit, and `odds_history` partition sizes.
2. On a staging stack with the same build, run `FONBET_SETTLE_ENABLED=true`
   for at least a week and compare every automatic settlement against
   Fonbet's own results page for the same matches — specifically the
   home/away orientation of 1X2 / handicap / team totals, OT handling on
   basketball, and the set/games split on tennis. The `settlement pass` log
   line's `skipped` map shows what the rules refused; each reason should
   be one you expect.
3. Only then flip `FONBET_SETTLE_ENABLED=true` on prod. Tickets that
   accumulated during step 1 settle on the first pass (the worker reads
   pending markets from Postgres, 7-day lookback).

## Historical note

Fonbet pushes no results. `services/settlement` only understands Oddin
AMQP messages, so Fonbet markets never reach `-3` and tickets on them stay
`accepted` forever. Options, in order of effort:

1. Score-based resolution for the main markets (1X2, double chance,
   handicap, total) from the final `liveEventInfos.scores` when a match
   flips to `closed` — covers most of the handle, exact rules per sport.
2. Fonbet's results endpoint (the site's `desktop.results` chunk loads a
   separate results API) — enumerate, decode, map factor → won/lost.
3. Manual admin settlement UI as the escape hatch.

The shipped design is option 2 (results feed) with option 1's score-based
rules on top of it; option 3 (manual settlement UI) remains the escape
hatch for whatever the rules leave open.

## Storefront

- `/sports` — traditional-sports tab (sidebar "Спорт" / "Sports"): the
  cross-sport live + upcoming lists filtered with `kind=traditional` on
  `GET /catalog/matches`, one chip per sport. The lobby, `/live` and
  `/upcoming` keep mixing both verticals.
- Match page: Fonbet sub-events render as tabs (`fb_<kind>` scopes derived
  from the `variant` specifier and the description prefix); deactivated
  markets are not loaded at all.
- Sport icons / team logos: `sports.logo_url`, `competitors.logo_url`,
  `tournaments.logo_url` from Fonbet's CDN; bundled SVGs for the nine
  sports without a Fonbet glyph.

### Tournament marks — coverage, and why half the rows have none

Measured against the live line on 2026-09-05, over the 761 segment nodes
then on offer:

| Source                                          | segments |
| ----------------------------------------------- | -------- |
| `line/logos` `competitions` (a real mark)        | 380      |
| `tournamentInfos[].icon` only (a real mark)      | 4        |
| `tournamentInfos[].icon` only, but a country flag | 107      |
| nothing at all                                   | 270      |

So **Fonbet itself has a competition mark for barely half its leagues.**
England's Championship, League 1, League 2 and League Cup all come back as
`"12018": "none"`; fon.bet's own Championship page draws
`/ContentCommon/NewFlags/Circle/England.svg` instead. The country flag is
their fallback, not a mark we are failing to fetch.

Two consequences the ingester encodes:

- Both sources are read and merged in `ingest.ApplyLogos`, `line/logos`
  winning. `fonbet.Client.TournamentIcons` derives the second from the
  `events/list` snapshot we already fetch, so it costs no extra request.
- **Flag paths (`/ContentCommon/NewFlags/`) are dropped**, and a logo-less
  tournament gets no `logo_url` at all. The storefront sidebar groups
  tournaments under a category header that already carries the country
  flag, so importing Fonbet's fallback would stamp the same flag down a
  whole country bucket. `TournamentLogoMark` in `sidebar.tsx` instead holds
  the 14px slot open across a group where any row has a mark, so the names
  keep a shared left edge — the same call `TeamMark` makes in declining to
  invent a monogram.

Re-run the measurement with
`go test -tags livesmoke ./internal/fonbet/ -run TestLiveSmoke -v`.

## Follow-ups

- Sub-event tabs (`fb_<kind>` scopes) take their label from the feed
  language and cannot yet be ordered from `/admin` (`fe_market_display_order`
  accepts `match | top | map_N | custom_*` only).
- Retired line markets stay as `status 0` rows; nothing prunes them yet.
- Two-way markets tied after main time without an OT row, exotic tables
  and unsupported sports stay open — a manual settlement UI is the escape
  hatch until the rules grow.
