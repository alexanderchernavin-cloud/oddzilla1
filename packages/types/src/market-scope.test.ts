import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveMarketScope,
  defaultScopeOrder,
  isCuratedScope,
  isMarketScope,
  isSubEventScope,
} from "./market-scope.js";

describe("scope grammar", () => {
  it("accepts every family the DB CHECK accepts", () => {
    for (const s of [
      "match",
      "top",
      "map_1",
      "map_12",
      "custom_ab12cd34ef56",
      "fb_100201",
      "fb_400100_10100201",
      "fb_players",
    ]) {
      assert.equal(isMarketScope(s), true, s);
    }
  });

  it("rejects shapes the DB CHECK rejects", () => {
    for (const s of [
      "map_0",
      "map_01",
      "fb_",
      "fb_100201_",
      "fb_abc",
      "fb_players_1",
      "custom_AB12",
      "1st half",
    ]) {
      assert.equal(isMarketScope(s), false, s);
    }
  });

  it("treats sub-events as pooled, not curated", () => {
    // Curated tabs have no implicit pool — sub-events do (whatever the
    // feed puts in them), so the admin's market list must be discovered.
    assert.equal(isCuratedScope("fb_100201"), false);
    assert.equal(isCuratedScope("top"), true);
    assert.equal(isCuratedScope("custom_ab12cd34ef56"), true);
    assert.equal(isSubEventScope("fb_players"), true);
  });
});

describe("deriveMarketScope", () => {
  it("puts a plain market on the Match tab", () => {
    const d = deriveMarketScope({
      specifiers: { threshold: "1.5" },
      template: "Total {threshold}",
    });
    assert.equal(d.scope.id, "match");
    assert.equal(d.scope.order, 0);
    assert.equal(d.baseTemplate, "Total {threshold}");
  });

  it("puts a map market on its own Map tab", () => {
    const d = deriveMarketScope({
      specifiers: { map: "2" },
      template: "Total kills {threshold} - map {map}",
    });
    assert.equal(d.scope.id, "map_2");
    assert.equal(d.scope.label, "Map 2");
    assert.equal(d.scope.order, 2);
  });

  it("takes a Fonbet sub-event tab from the template prefix", () => {
    const d = deriveMarketScope({
      specifiers: { variant: "fb:100201", threshold: "1.5" },
      template: "1st half: Total {threshold}",
      baseTemplate: "1st half: Total",
    });
    assert.equal(d.scope.id, "fb_100201");
    assert.equal(d.scope.label, "1st half");
    // The prefix comes off the BASE name only — market.name keeps it,
    // because that string is what a bet-slip leg is labelled with.
    assert.equal(d.baseTemplate, "Total");
  });

  it("nests a sub-event of a sub-event and sorts it after its parent", () => {
    const parent = deriveMarketScope({
      specifiers: { variant: "fb:400100" },
      template: "Corners: Match result",
    });
    const child = deriveMarketScope({
      specifiers: { variant: "fb:400100/10100201" },
      template: "1st half corners: Match result",
    });
    assert.equal(child.scope.id, "fb_400100_10100201");
    assert.equal(child.scope.label, "1st half corners");
    assert.ok(child.scope.order > parent.scope.order);
    assert.ok(parent.scope.order > 10);
  });

  it("collapses every per-player variant into one tab", () => {
    const a = deriveMarketScope({
      specifiers: { variant: "fb:90/91:545773" },
      template: "Player specials. Player bets Zobnin R: {threshold}",
    });
    const b = deriveMarketScope({
      specifiers: { variant: "fb:90/91:830368" },
      template: "Player specials. Player bets Smith J: {threshold}",
    });
    assert.equal(a.scope.id, "fb_players");
    assert.equal(b.scope.id, "fb_players");
    assert.equal(a.scope.label, "Players");
    assert.equal(
      deriveMarketScope({
        specifiers: { variant: "fb:90/91:545773" },
        template: "x",
        playersLabel: "Игроки",
      }).scope.label,
      "Игроки",
    );
  });

  it("keeps an undescribed sub-event on Match rather than opening a blank tab", () => {
    const d = deriveMarketScope({
      specifiers: { variant: "fb:100201" },
      template: "Market #1000305",
    });
    assert.equal(d.scope.id, "match");
  });

  it("ignores non-Fonbet variants", () => {
    for (const variant of ["way:two", "mr:12", "best_of:3", "od:dynamic_outcomes:11981"]) {
      const d = deriveMarketScope({
        specifiers: { variant },
        template: "Match result",
      });
      assert.equal(d.scope.id, "match", variant);
    }
  });
});

describe("defaultScopeOrder", () => {
  it("reproduces the order a derived scope carries", () => {
    for (const [specifiers, template] of [
      [{ map: "3" }, "Total - map {map}"],
      [{ variant: "fb:100201" }, "1st half: Total"],
      [{ variant: "fb:400100/10100201" }, "1st half corners: Total"],
      [{ variant: "fb:90/91:1" }, "Player: Total"],
      [{}, "Total"],
    ] as const) {
      const d = deriveMarketScope({ specifiers, template });
      assert.equal(defaultScopeOrder(d.scope.id), d.scope.order, d.scope.id);
    }
  });

  it("sorts Top ahead of Match", () => {
    assert.ok(defaultScopeOrder("top") < defaultScopeOrder("match"));
  });
});
