// /admin/slotzilla — backoffice for the 15-second live-basketball slot
// (docs/SLOTZILLA.md): the operator settings singleton, paytables and
// the calibrator, the games table with its return monitor, the feed
// status card, and the calibration corpus.
//
// Every mutation writes admin_audit_log in the same transaction. All
// money on the wire is decimal strings of micro units (invariant 1).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  matches,
  slotzillaConfig,
  slotzillaGames,
  slotzillaPaytables,
  SLOTZILLA_GAME_STATUSES,
  SLOTZILLA_SINGLETON_ID,
  tournaments,
  type SlotzillaConfig,
  type SlotzillaPaytable,
} from "@oddzilla/db";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types/currencies";
import {
  DEFAULT_PAYTABLE_LINES,
  isLineKey,
  type PaytableLines,
} from "@oddzilla/types/slotzilla";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { fitCorpus, summariseCorpus } from "../../lib/slotzilla/calibrator.js";
import { createCorpusClient, fetchCorpus, loadCorpusEvents } from "../../lib/slotzilla/corpus.js";
import {
  FEED_STATUS_KEY,
  loadConfig,
  loadSpinPage,
  paytableLinesOf,
  publishSpinFrame,
  returnBp,
  spinToView,
  voidOpenSpinsForGame,
} from "../../lib/slotzilla/service.js";

// ── Wire shapes ─────────────────────────────────────────────────────────

function configToResponse(row: SlotzillaConfig) {
  return {
    enabled: row.enabled,
    currencies: row.currencies,
    rtpTargetBp: row.rtpTargetBp,
    leadSeconds: row.leadSeconds,
    clockPastSeconds: row.clockPastSeconds,
    graceSeconds: row.graceSeconds,
    feedDarkVoidSeconds: row.feedDarkVoidSeconds,
    minStakeMicro: row.minStakeMicro.toString(),
    maxStakeMicro: row.maxStakeMicro.toString(),
    maxPayoutMicro: row.maxPayoutMicro.toString(),
    matchLiabilityCapMicro: row.matchLiabilityCapMicro.toString(),
    returnAlarmMarginBp: row.returnAlarmMarginBp,
    returnAlarmMinSpins: row.returnAlarmMinSpins,
    autoplayEnabled: row.autoplayEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function paytableToResponse(row: SlotzillaPaytable) {
  return {
    id: row.id.toString(),
    name: row.name,
    lines: paytableLinesOf(row.lines),
    fittedRtpBp: row.fittedRtpBp,
    corpusNote: row.corpusNote,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Validation ──────────────────────────────────────────────────────────

const microString = z.string().regex(/^\d{1,20}$/u);

// Mirrors the CHECK constraints in 20260909T211312_slotzilla.sql so a
// bad value is a typed 400 rather than a bare 500 from Postgres.
const configBody = z.object({
  enabled: z.boolean(),
  currencies: z.array(z.enum(SUPPORTED_CURRENCIES)).max(SUPPORTED_CURRENCIES.length),
  rtpTargetBp: z.number().int().min(5000).max(9900),
  leadSeconds: z.number().int().min(5).max(60),
  clockPastSeconds: z.number().int().min(0).max(60),
  graceSeconds: z.number().int().min(0).max(120),
  feedDarkVoidSeconds: z.number().int().min(30).max(3600),
  minStakeMicro: microString,
  maxStakeMicro: microString,
  maxPayoutMicro: microString,
  matchLiabilityCapMicro: microString,
  returnAlarmMarginBp: z.number().int().min(0).max(10_000),
  returnAlarmMinSpins: z.number().int().min(1).max(100_000),
  autoplayEnabled: z.boolean(),
});

const linesBody = z.record(z.string(), z.number().int().min(0).max(10_000_000));

function parseLines(raw: Record<string, number>): PaytableLines {
  const out: PaytableLines = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isLineKey(k)) throw new BadRequestError(`invalid_line_key: ${k}`, "invalid_line_key");
    out[k] = v;
  }
  return out;
}

const paytableCreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  lines: linesBody,
  fittedRtpBp: z.number().int().min(0).max(20_000).nullable().optional(),
  corpusNote: z.string().trim().max(500).nullable().optional(),
});

const paytableUpdateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  lines: linesBody.optional(),
  fittedRtpBp: z.number().int().min(0).max(20_000).nullable().optional(),
  corpusNote: z.string().trim().max(500).nullable().optional(),
});

const idParams = z.object({ id: z.coerce.bigint() });
const matchParams = z.object({ matchId: z.coerce.bigint() });

const fitBody = z.object({
  baseId: z.coerce.bigint().optional(),
  targetBp: z.number().int().min(5000).max(9900).optional(),
  coverageLevel: z.number().int().min(1).max(9).optional(),
});

const corpusFetchBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  srSportId: z.number().int().positive().default(2),
  maxMatches: z.number().int().min(1).max(1000).default(200),
});

const gamesQuery = z.object({
  status: z.enum(SLOTZILLA_GAME_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const spinsQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const noteBody = z.object({ note: z.string().trim().max(500).optional() });

type AuditRow = typeof adminAuditLog.$inferInsert;

export default async function adminSlotzillaRoutes(app: FastifyInstance) {
  const audit = (
    request: { ip?: string },
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    beforeJson: unknown,
    afterJson: unknown,
  ): AuditRow => ({
    actorUserId,
    action,
    targetType,
    targetId,
    beforeJson: beforeJson as Record<string, unknown> | null,
    afterJson: afterJson as Record<string, unknown> | null,
    ipInet: request.ip ?? null,
  });

  // ── Config ────────────────────────────────────────────────────────────

  app.get("/admin/slotzilla/config", async (request) => {
    request.requireRole("admin");
    return configToResponse(await loadConfig(app.db));
  });

  app.put("/admin/slotzilla/config", async (request) => {
    const admin = request.requireRole("admin");
    const body = configBody.parse(request.body);
    const minStake = BigInt(body.minStakeMicro);
    const maxStake = BigInt(body.maxStakeMicro);
    const maxPayout = BigInt(body.maxPayoutMicro);
    const matchCap = BigInt(body.matchLiabilityCapMicro);
    if (minStake <= 0n || maxStake < minStake) {
      throw new BadRequestError("stake_bounds_inverted", "stake_bounds_inverted");
    }
    if (maxPayout <= 0n || matchCap <= 0n) {
      throw new BadRequestError("caps_must_be_positive", "caps_must_be_positive");
    }
    const currencies = Array.from(new Set(body.currencies));

    const before = await loadConfig(app.db);
    const updated = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .update(slotzillaConfig)
        .set({
          enabled: body.enabled,
          currencies,
          rtpTargetBp: body.rtpTargetBp,
          leadSeconds: body.leadSeconds,
          clockPastSeconds: body.clockPastSeconds,
          graceSeconds: body.graceSeconds,
          feedDarkVoidSeconds: body.feedDarkVoidSeconds,
          minStakeMicro: minStake,
          maxStakeMicro: maxStake,
          maxPayoutMicro: maxPayout,
          matchLiabilityCapMicro: matchCap,
          returnAlarmMarginBp: body.returnAlarmMarginBp,
          returnAlarmMinSpins: body.returnAlarmMinSpins,
          autoplayEnabled: body.autoplayEnabled,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(slotzillaConfig.id, SLOTZILLA_SINGLETON_ID))
        .returning();
      if (!row) throw new Error("slotzilla_config update returned no row");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.config.update",
            "slotzilla_config",
            SLOTZILLA_SINGLETON_ID,
            configToResponse(before),
            configToResponse(row),
          ),
        );
      return row;
    });
    return configToResponse(updated);
  });

  // ── Feed status card ──────────────────────────────────────────────────

  app.get("/admin/slotzilla/status", async (request) => {
    request.requireRole("admin");
    const [hash, counts] = await Promise.all([
      app.redis.hgetall(FEED_STATUS_KEY).catch(() => ({}) as Record<string, string>),
      app.db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM slotzilla_games)::int AS games,
          (SELECT COUNT(*) FROM slotzilla_games WHERE status = 'live')::int AS live_games,
          (SELECT COUNT(*) FROM slotzilla_spins WHERE status = 'open')::int AS open_spins
      `) as unknown as Promise<Array<{ games: number; live_games: number; open_spins: number }>>,
    ]);
    const num = (key: string): number | null => {
      const v = hash[key];
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const nowUnix = Math.floor(Date.now() / 1000);
    const updatedUnix = num("updated_unix");
    const c = counts[0];
    return {
      online: updatedUnix !== null && nowUnix - updatedUnix < 30,
      updatedUnix,
      games: Number(c?.games ?? 0),
      liveGames: Number(c?.live_games ?? 0),
      openSpins: Number(c?.open_spins ?? 0),
      lastFetchUnix: num("last_fetch_unix"),
      lastError: hash.last_error || null,
      pollMs: num("poll_ms"),
    };
  });

  // ── Games ─────────────────────────────────────────────────────────────

  app.get("/admin/slotzilla/games", async (request) => {
    request.requireRole("admin");
    const q = gamesQuery.parse(request.query);
    const [cfg, rows] = await Promise.all([
      loadConfig(app.db),
      app.db
        .select({
          game: slotzillaGames,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          tournament: tournaments.name,
        })
        .from(slotzillaGames)
        .innerJoin(matches, eq(matches.id, slotzillaGames.matchId))
        .leftJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .where(q.status ? eq(slotzillaGames.status, q.status) : undefined)
        .orderBy(desc(slotzillaGames.updatedAt))
        .limit(q.limit),
    ]);
    const games = rows.map(({ game: g, homeTeam, awayTeam, tournament }) => {
      const usdc = returnBp(g.usdcStakeMicro, g.usdcPayoutMicro);
      const oz = returnBp(g.ozStakeMicro, g.ozPayoutMicro);
      const threshold = cfg.rtpTargetBp + cfg.returnAlarmMarginBp;
      const alarm =
        g.spinsCount >= cfg.returnAlarmMinSpins &&
        ((usdc !== null && usdc > threshold) || (oz !== null && oz > threshold));
      return {
        matchId: g.matchId.toString(),
        srMatchId: g.srMatchId.toString(),
        homeTeam,
        awayTeam,
        tournament: tournament ?? null,
        status: g.status,
        coverageLevel: g.coverageLevel,
        clock: {
          seconds: g.clockSeconds,
          running: g.clockRunning,
          period: g.clockPeriod,
          readAt: g.clockReadAt ? g.clockReadAt.toISOString() : null,
        },
        feedLagMs: g.feedLagMs,
        spinsCount: g.spinsCount,
        totals: {
          USDC: {
            stakeMicro: g.usdcStakeMicro.toString(),
            payoutMicro: g.usdcPayoutMicro.toString(),
            returnBp: usdc,
          },
          OZ: {
            stakeMicro: g.ozStakeMicro.toString(),
            payoutMicro: g.ozPayoutMicro.toString(),
            returnBp: oz,
          },
        },
        alarm,
        pausedAt: g.pausedAt ? g.pausedAt.toISOString() : null,
        note: g.note,
      };
    });
    return { games };
  });

  async function loadGameOr404(matchId: bigint) {
    const [game] = await app.db
      .select()
      .from(slotzillaGames)
      .where(eq(slotzillaGames.matchId, matchId))
      .limit(1);
    if (!game) throw new NotFoundError("slotzilla_game_not_found", "slotzilla_game_not_found");
    return game;
  }

  const gameAudit = (g: typeof slotzillaGames.$inferSelect) => ({
    status: g.status,
    pausedBy: g.pausedBy,
    pausedAt: g.pausedAt ? g.pausedAt.toISOString() : null,
    note: g.note,
  });

  app.post("/admin/slotzilla/games/:matchId/pause", async (request) => {
    const admin = request.requireRole("admin");
    const { matchId } = matchParams.parse(request.params);
    const body = noteBody.parse(request.body ?? {});
    const before = await loadGameOr404(matchId);
    if (before.status !== "live" && before.status !== "scheduled") {
      throw new ConflictError("game_not_pausable", "game_not_pausable");
    }
    const updated = await app.db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .update(slotzillaGames)
        .set({
          status: "paused",
          pausedBy: admin.id,
          pausedAt: now,
          note: body.note ?? before.note,
          updatedAt: now,
        })
        .where(and(eq(slotzillaGames.matchId, matchId), eq(slotzillaGames.status, before.status)))
        .returning();
      if (!row) throw new ConflictError("game_state_changed", "game_state_changed");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.game.pause",
            "slotzilla_game",
            matchId.toString(),
            gameAudit(before),
            gameAudit(row),
          ),
        );
      return row;
    });
    return { matchId: matchId.toString(), status: updated.status };
  });

  app.post("/admin/slotzilla/games/:matchId/resume", async (request) => {
    const admin = request.requireRole("admin");
    const { matchId } = matchParams.parse(request.params);
    const before = await loadGameOr404(matchId);
    if (before.status !== "paused") {
      throw new ConflictError("game_not_paused", "game_not_paused");
    }
    // Back to live if the match had tipped off, else the service picks
    // it up as scheduled and promotes it on the next poll.
    const next = before.clockSeconds !== null ? "live" : "scheduled";
    const updated = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .update(slotzillaGames)
        .set({ status: next, pausedBy: null, pausedAt: null, updatedAt: new Date() })
        .where(and(eq(slotzillaGames.matchId, matchId), eq(slotzillaGames.status, "paused")))
        .returning();
      if (!row) throw new ConflictError("game_state_changed", "game_state_changed");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.game.resume",
            "slotzilla_game",
            matchId.toString(),
            gameAudit(before),
            gameAudit(row),
          ),
        );
      return row;
    });
    return { matchId: matchId.toString(), status: updated.status };
  });

  app.post("/admin/slotzilla/games/:matchId/void", async (request) => {
    const admin = request.requireRole("admin");
    const { matchId } = matchParams.parse(request.params);
    const body = noteBody.parse(request.body ?? {});
    const before = await loadGameOr404(matchId);
    if (before.status === "voided") {
      throw new ConflictError("game_already_voided", "game_already_voided");
    }
    const { voided, row } = await app.db.transaction(async (tx) => {
      // Lock the game row first so a concurrent placement waits on us
      // and then sees status = voided.
      await tx
        .select({ matchId: slotzillaGames.matchId })
        .from(slotzillaGames)
        .where(eq(slotzillaGames.matchId, matchId))
        .for("update");
      const voided = await voidOpenSpinsForGame(tx, matchId, "admin_void");
      const now = new Date();
      const [row] = await tx
        .update(slotzillaGames)
        .set({ status: "voided", note: body.note ?? before.note, updatedAt: now })
        .where(eq(slotzillaGames.matchId, matchId))
        .returning();
      if (!row) throw new Error("slotzilla_games void returned no row");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.game.void",
            "slotzilla_game",
            matchId.toString(),
            gameAudit(before),
            { ...gameAudit(row), voidedSpins: voided.length },
          ),
        );
      return { voided, row };
    });
    for (const v of voided) await publishSpinFrame(app, v.userId, v.view);
    app.log.info(
      { matchId: matchId.toString(), voided: voided.length, admin: admin.id },
      "slotzilla: game voided by admin",
    );
    return { matchId: matchId.toString(), status: row.status, voidedSpins: voided.length };
  });

  app.get("/admin/slotzilla/games/:matchId/spins", async (request) => {
    request.requireRole("admin");
    const { matchId } = matchParams.parse(request.params);
    const q = spinsQuery.parse(request.query);
    await loadGameOr404(matchId);
    const page = await loadSpinPage(app.db, { matchId }, q.cursor, q.limit);
    return {
      spins: page.rows.map((r) => ({
        ...spinToView(r),
        userId: r.userId,
        exposureMicro: r.exposureMicro.toString(),
        paytableId: r.paytableId.toString(),
        reelEventIds: (r.reelEventIds ?? []).map((id) => id.toString()),
        autoplay: r.autoplay,
      })),
      nextCursor: page.nextCursor,
    };
  });

  // ── Paytables ─────────────────────────────────────────────────────────

  app.get("/admin/slotzilla/paytables", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(slotzillaPaytables)
      .orderBy(desc(slotzillaPaytables.active), desc(slotzillaPaytables.updatedAt));
    return { paytables: rows.map(paytableToResponse) };
  });

  app.post("/admin/slotzilla/paytables", async (request, reply) => {
    const admin = request.requireRole("admin");
    const body = paytableCreateBody.parse(request.body);
    const lines = parseLines(body.lines);
    const row = await app.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(slotzillaPaytables)
        .values({
          name: body.name,
          lines,
          fittedRtpBp: body.fittedRtpBp ?? null,
          corpusNote: body.corpusNote ?? null,
          active: false,
          updatedBy: admin.id,
        })
        .returning();
      if (!inserted) throw new Error("slotzilla_paytables insert returned no row");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.paytable.create",
            "slotzilla_paytable",
            inserted.id.toString(),
            null,
            paytableToResponse(inserted),
          ),
        );
      return inserted;
    });
    reply.code(201);
    return paytableToResponse(row);
  });

  app.put("/admin/slotzilla/paytables/:id", async (request) => {
    const admin = request.requireRole("admin");
    const { id } = idParams.parse(request.params);
    const body = paytableUpdateBody.parse(request.body);
    const [before] = await app.db
      .select()
      .from(slotzillaPaytables)
      .where(eq(slotzillaPaytables.id, id))
      .limit(1);
    if (!before) throw new NotFoundError("paytable_not_found", "paytable_not_found");
    // Spins pin their paytable id at placement and the settler prices
    // from the pinned row, so editing a table in use changes what the
    // NEXT spins pay, never what an open one does.
    const row = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(slotzillaPaytables)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.lines !== undefined ? { lines: parseLines(body.lines) } : {}),
          ...(body.fittedRtpBp !== undefined ? { fittedRtpBp: body.fittedRtpBp } : {}),
          ...(body.corpusNote !== undefined ? { corpusNote: body.corpusNote } : {}),
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(slotzillaPaytables.id, id))
        .returning();
      if (!updated) throw new NotFoundError("paytable_not_found", "paytable_not_found");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.paytable.update",
            "slotzilla_paytable",
            id.toString(),
            paytableToResponse(before),
            paytableToResponse(updated),
          ),
        );
      return updated;
    });
    return paytableToResponse(row);
  });

  app.post("/admin/slotzilla/paytables/:id/activate", async (request) => {
    const admin = request.requireRole("admin");
    const { id } = idParams.parse(request.params);
    const [target] = await app.db
      .select()
      .from(slotzillaPaytables)
      .where(eq(slotzillaPaytables.id, id))
      .limit(1);
    if (!target) throw new NotFoundError("paytable_not_found", "paytable_not_found");
    if (target.active) return paytableToResponse(target);
    const row = await app.db.transaction(async (tx) => {
      // The partial unique index allows exactly one active row, so the
      // old one must go inactive in the same statement order.
      const [previous] = await tx
        .update(slotzillaPaytables)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(slotzillaPaytables.active, true))
        .returning();
      const [activated] = await tx
        .update(slotzillaPaytables)
        .set({ active: true, updatedBy: admin.id, updatedAt: new Date() })
        .where(eq(slotzillaPaytables.id, id))
        .returning();
      if (!activated) throw new NotFoundError("paytable_not_found", "paytable_not_found");
      await tx
        .insert(adminAuditLog)
        .values(
          audit(
            request,
            admin.id,
            "slotzilla.paytable.activate",
            "slotzilla_paytable",
            id.toString(),
            previous ? { activeId: previous.id.toString() } : { activeId: null },
            { activeId: activated.id.toString() },
          ),
        );
      return activated;
    });
    return paytableToResponse(row);
  });

  app.post("/admin/slotzilla/paytables/fit", async (request) => {
    request.requireRole("admin");
    const body = fitBody.parse(request.body ?? {});
    const cfg = await loadConfig(app.db);
    let base: PaytableLines = { ...DEFAULT_PAYTABLE_LINES };
    if (body.baseId !== undefined) {
      const [row] = await app.db
        .select()
        .from(slotzillaPaytables)
        .where(eq(slotzillaPaytables.id, body.baseId))
        .limit(1);
      if (!row) throw new NotFoundError("paytable_not_found", "paytable_not_found");
      base = paytableLinesOf(row.lines);
    } else {
      const [active] = await app.db
        .select()
        .from(slotzillaPaytables)
        .where(eq(slotzillaPaytables.active, true))
        .limit(1);
      if (active) base = paytableLinesOf(active.lines);
    }
    const events = await loadCorpusEvents(
      app.db,
      body.coverageLevel === undefined ? {} : { coverageLevel: body.coverageLevel },
    );
    const fit = fitCorpus(events, base, body.targetBp ?? cfg.rtpTargetBp);
    if (fit.corpus.rounds === 0) {
      throw new BadRequestError("corpus_empty", "corpus_empty");
    }
    return fit;
  });

  // ── Corpus ────────────────────────────────────────────────────────────

  app.get("/admin/slotzilla/corpus/summary", async (request) => {
    request.requireRole("admin");
    const events = await loadCorpusEvents(app.db);
    const s = summariseCorpus(events);
    return { matches: s.matches, events: s.events, rounds: s.rounds, byLine: s.byLine };
  });

  app.post(
    "/admin/slotzilla/corpus/fetch",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = corpusFetchBody.parse(request.body);
      const client = createCorpusClient();
      const result = await fetchCorpus(
        app.db,
        client,
        { from: body.from, to: body.to, srSportId: body.srSportId, maxMatches: body.maxMatches },
        app.log,
      );
      await app.db.insert(adminAuditLog).values(
        audit(
          request,
          admin.id,
          "slotzilla.corpus.fetch",
          "sr_live_events",
          `${body.srSportId}:${body.from}..${body.to}`,
          null,
          { ...result, maxMatches: body.maxMatches },
        ),
      );
      return result;
    },
  );
}
