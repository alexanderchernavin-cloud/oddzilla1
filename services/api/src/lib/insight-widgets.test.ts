import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveInsightEnabled,
  isFullyDisabled,
  type InsightCascade,
} from "./insight-widgets.js";

function cascade(init: Partial<InsightCascade> = {}): InsightCascade {
  return {
    global: null,
    bySport: new Map(),
    byCategory: new Map(),
    byTournament: new Map(),
    byMarket: new Map(),
    ...init,
  };
}

const ctx = { sportId: 1, categoryId: 10, tournamentId: 100, providerMarketId: 1000 };

test("falls back to the global row when nothing else matches", () => {
  assert.equal(resolveInsightEnabled(cascade({ global: true }), ctx), true);
  assert.equal(resolveInsightEnabled(cascade({ global: false }), ctx), false);
});

test("fails closed when even the global row is missing", () => {
  // Only reachable if someone deleted the seeded row. A widget nobody
  // configured must not appear.
  assert.equal(resolveInsightEnabled(cascade(), ctx), false);
});

test("each tier overrides the one below it", () => {
  const sport = cascade({ global: false, bySport: new Map([[1, true]]) });
  assert.equal(resolveInsightEnabled(sport, ctx), true);

  const category = cascade({
    global: false,
    bySport: new Map([[1, true]]),
    byCategory: new Map([[10, false]]),
  });
  assert.equal(resolveInsightEnabled(category, ctx), false);

  const tournament = cascade({
    global: false,
    bySport: new Map([[1, true]]),
    byCategory: new Map([[10, false]]),
    byTournament: new Map([[100, true]]),
  });
  assert.equal(resolveInsightEnabled(tournament, ctx), true);

  const market = cascade({
    global: true,
    bySport: new Map([[1, true]]),
    byCategory: new Map([[10, true]]),
    byTournament: new Map([[100, true]]),
    byMarket: new Map([[1000, false]]),
  });
  assert.equal(resolveInsightEnabled(market, ctx), false);
});

test("a market rule is skipped when the caller asks about the match, not a market", () => {
  // The match-level probe ("is this widget on here at all?") passes no
  // market, so a market rule must not decide it.
  const c = cascade({ global: true, byMarket: new Map([[1000, false]]) });
  assert.equal(
    resolveInsightEnabled(c, { sportId: 1, categoryId: 10, tournamentId: 100 }),
    true,
  );
});

test("a null ref never matches a rule keyed on that tier", () => {
  const c = cascade({ global: true, bySport: new Map([[1, false]]) });
  assert.equal(
    resolveInsightEnabled(c, { sportId: null, categoryId: null, tournamentId: null }),
    true,
  );
});

test("isFullyDisabled is true only when nothing anywhere turns it on", () => {
  assert.equal(isFullyDisabled(cascade({ global: false })), true);
  assert.equal(isFullyDisabled(cascade()), true);
  assert.equal(isFullyDisabled(cascade({ global: true })), false);
  assert.equal(
    isFullyDisabled(cascade({ global: false, bySport: new Map([[1, true]]) })),
    false,
  );
  // An explicit OFF at a narrower scope is not an exception to "off
  // everywhere" — it agrees with it.
  assert.equal(
    isFullyDisabled(cascade({ global: false, byTournament: new Map([[100, false]]) })),
    true,
  );
});
