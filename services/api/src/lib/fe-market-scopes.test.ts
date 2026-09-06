import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScopes } from "./fe-market-scopes.js";

const FOOTBALL = 7;
const CS2 = 3;

// Shapes taken from the production offer (2026-09-05): football carries
// its sub-events on the `variant` specifier, cs2 its maps on `map`.
const descs = [
  { providerMarketId: 1000120, variant: "", nameTemplate: "Match result" },
  { providerMarketId: 1000305, variant: "", nameTemplate: "Total {threshold}" },
  { providerMarketId: 1000120, variant: "fb:100201", nameTemplate: "1st half: Match result" },
  { providerMarketId: 1000305, variant: "fb:100201", nameTemplate: "1st half: Total {threshold}" },
  { providerMarketId: 1000120, variant: "fb:400100", nameTemplate: "Corners: Match result" },
  {
    providerMarketId: 1000305,
    variant: "fb:400100",
    nameTemplate: "Corners: Total {threshold}",
  },
  {
    providerMarketId: 1000120,
    variant: "fb:400100/10100201",
    nameTemplate: "1st half corners: Match result",
  },
  {
    providerMarketId: 1020200,
    variant: "fb:90/91:0",
    nameTemplate: "Player specials. Player bets: {threshold}",
  },
  { providerMarketId: 4, variant: "", nameTemplate: "Map winner" },
];

function row(
  sportId: number,
  providerMarketId: number,
  map: string | null = null,
  variant: string | null = null,
) {
  return { sportId, providerMarketId, map, variant };
}

describe("buildScopes", () => {
  it("gives a Fonbet sport the tabs its sub-events actually produce", () => {
    const out = buildScopes(
      [
        row(FOOTBALL, 1000120),
        row(FOOTBALL, 1000305),
        row(FOOTBALL, 1000120, null, "fb:100201"),
        row(FOOTBALL, 1000305, null, "fb:100201"),
        row(FOOTBALL, 1000120, null, "fb:400100"),
        row(FOOTBALL, 1000120, null, "fb:400100/10100201"),
        row(FOOTBALL, 1020200, null, "fb:90/91:0"),
      ],
      descs,
    );
    const football = out.get(FOOTBALL);
    assert.ok(football);
    assert.deepEqual(
      football.scopes.map((s) => s.scope),
      ["match", "fb_100201", "fb_400100", "fb_400100_10100201", "fb_players"],
    );
    // No Map tabs — the screen used to offer football Map 1..5, which no
    // football fixture has ever had.
    assert.equal(
      football.scopes.some((s) => s.scope.startsWith("map_")),
      false,
    );
    assert.deepEqual(
      football.scopes.map((s) => s.label),
      [null, "1st half", "Corners", "1st half corners", "Players"],
    );
  });

  it("lists the real markets per tab, each named in full", () => {
    const out = buildScopes(
      [
        row(FOOTBALL, 1000120),
        row(FOOTBALL, 1000305),
        row(FOOTBALL, 1000120, null, "fb:100201"),
        row(FOOTBALL, 1000305, null, "fb:100201"),
        row(FOOTBALL, 1000120, null, "fb:400100"),
      ],
      descs,
    );
    const scopes = out.get(FOOTBALL)!.scopes;
    const half = scopes.find((s) => s.scope === "fb_100201")!;
    // The prefix stays on. "Total {threshold}" on the 1st-half tab reads
    // the same as "Total {threshold}" on the corners tab and on twelve
    // others, and a tab can now hold markets imported from another
    // sub-event, so the row has to say which one it is.
    assert.deepEqual(half.markets, [
      { providerMarketId: 1000120, label: "1st half: Match result" },
      { providerMarketId: 1000305, label: "1st half: Total {threshold}" },
    ]);
    const corners = scopes.find((s) => s.scope === "fb_400100")!;
    assert.deepEqual(corners.markets.map((m) => m.providerMarketId), [1000120]);
    // The Match tab holds only the base event, not every sub-event's copy.
    const match = scopes.find((s) => s.scope === "match")!;
    assert.deepEqual(match.markets.map((m) => m.providerMarketId), [1000120, 1000305]);
  });

  it("collapses every player variant into one tab", () => {
    const out = buildScopes(
      [
        row(FOOTBALL, 1020200, null, "fb:90/91:0"),
        row(FOOTBALL, 1000120, null, "fb:90/91:0"),
      ],
      descs,
    );
    const scopes = out.get(FOOTBALL)!.scopes;
    assert.equal(scopes.filter((s) => s.scope === "fb_players").length, 1);
    assert.deepEqual(
      scopes.find((s) => s.scope === "fb_players")!.markets.map((m) => m.providerMarketId),
      [1000120, 1020200],
    );
  });

  it("offers a mapped sport five map tabs sharing one pool", () => {
    const out = buildScopes(
      [row(CS2, 4), row(CS2, 4, "1"), row(CS2, 1000305, "2")],
      descs,
    );
    const scopes = out.get(CS2)!.scopes;
    assert.deepEqual(
      scopes.map((s) => s.scope),
      ["match", "map_1", "map_2", "map_3", "map_4", "map_5"],
    );
    // Map 4 has nothing live under it and still lists what a map tab can
    // hold, so it can be configured before the series gets there.
    const ids = (scope: string) =>
      scopes.find((s) => s.scope === scope)!.markets.map((m) => m.providerMarketId);
    assert.deepEqual(ids("map_4"), [4, 1000305]);
    assert.deepEqual(ids("map_1"), ids("map_4"));
    assert.deepEqual(ids("match"), [4]);
  });

  it("keeps a Match tab even when the whole offer is sub-events", () => {
    const out = buildScopes([row(FOOTBALL, 1000120, null, "fb:100201")], descs);
    const scopes = out.get(FOOTBALL)!.scopes;
    assert.equal(scopes[0]?.scope, "match");
    assert.deepEqual(scopes[0]?.markets, []);
  });

  it("puts an undescribed market on Match rather than a blank tab", () => {
    const out = buildScopes([row(FOOTBALL, 999999, null, "fb:100201")], []);
    const scopes = out.get(FOOTBALL)!.scopes;
    assert.deepEqual(scopes.map((s) => s.scope), ["match"]);
    assert.deepEqual(scopes[0]?.markets, [
      { providerMarketId: 999999, label: "Market #999999" },
    ]);
  });

  it("keeps sports apart", () => {
    const out = buildScopes(
      [row(FOOTBALL, 1000120, null, "fb:100201"), row(CS2, 4, "1")],
      descs,
    );
    assert.deepEqual(
      out.get(FOOTBALL)!.scopes.map((s) => s.scope),
      ["match", "fb_100201"],
    );
    assert.equal(out.get(CS2)!.scopes.some((s) => s.scope === "fb_100201"), false);
  });
});

// The curated pool is what the Top / custom-group picker offers. It is the
// one place that has to be per (market type, sub-event): provider_market_id
// alone is the catalogue table, and Fonbet reuses one table across every
// sub-event, so football's ~470 markets collapse to 14 ids.
describe("curated pool", () => {
  it("offers the same market type once per sub-event", () => {
    const out = buildScopes(
      [
        row(FOOTBALL, 1000305),
        row(FOOTBALL, 1000305, null, "fb:100201"),
        row(FOOTBALL, 1000305, null, "fb:400100"),
        row(FOOTBALL, 1000120, null, "fb:400100"),
      ],
      descs,
    );
    const all = out.get(FOOTBALL)!.allMarkets;
    assert.deepEqual(
      all.map((m) => [m.providerMarketId, m.variant, m.label, m.scope]),
      [
        [1000305, "", "Total {threshold}", "match"],
        [1000305, "fb:100201", "1st half: Total {threshold}", "fb_100201"],
        [1000120, "fb:400100", "Corners: Match result", "fb_400100"],
        [1000305, "fb:400100", "Corners: Total {threshold}", "fb_400100"],
      ],
    );
  });

  it("keeps the per-tab list keyed by market type", () => {
    // Inside one tab the sub-event is fixed, so splitting by variant there
    // would just fragment the list.
    const out = buildScopes(
      [row(FOOTBALL, 1000305, null, "fb:100201"), row(FOOTBALL, 1000120, null, "fb:100201")],
      descs,
    );
    const half = out.get(FOOTBALL)!.scopes.find((s) => s.scope === "fb_100201")!;
    assert.deepEqual(half.markets.map((m) => m.providerMarketId), [1000120, 1000305]);
    assert.deepEqual(half.markets.map((m) => m.label), [
      "1st half: Match result",
      "1st half: Total {threshold}",
    ]);
  });

  it("collapses per-player markets to one wildcard pick", () => {
    // One entry per footballer would be thousands of picks, and the tab
    // itself is already collapsed.
    const out = buildScopes([row(FOOTBALL, 1020200, null, "fb:90/91:0")], descs);
    const all = out.get(FOOTBALL)!.allMarkets;
    assert.equal(all.length, 1);
    assert.equal(all[0]?.variant, "");
    assert.equal(all[0]?.scope, "fb_players");
  });

  it("names a market whose whole caption is its sub-event prefix", () => {
    // Fonbet ships a few tables with no name of their own; they rendered as
    // blank, unpickable rows.
    const out = buildScopes(
      [row(FOOTBALL, 1002800, null, "fb:100201")],
      [
        ...descs,
        { providerMarketId: 1002800, variant: "fb:100201", nameTemplate: "1st half: " },
      ],
    );
    const all = out.get(FOOTBALL)!.allMarkets;
    assert.equal(all[0]?.label, "1st half: Market #1002800");
    const tab = out.get(FOOTBALL)!.scopes.find((s) => s.scope === "fb_100201")!;
    assert.equal(tab.markets[0]?.label, "1st half: Market #1002800");
  });
});
