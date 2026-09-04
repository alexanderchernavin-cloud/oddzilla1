// The Sportradar mapping pipeline.
//
// Fetch (or accept) a batch of Sportradar fixtures for one sport, pair
// them against our open matches, and persist the result. Shared by three
// callers so they cannot drift in what they accept:
//
//   * POST /admin/sportradar/import  — an operator pastes fixtures
//   * POST /admin/sportradar/sync    — an operator presses Sync
//   * the background sweeper         — nobody presses anything
//
// The rules that matter live here rather than in any one caller: only
// matches inside the window are considered, a human decision is never
// overwritten, and a Sportradar fixture already claimed by another match
// is skipped rather than allowed to fail the batch.

import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  adminAuditLog,
  categories,
  matchSportradarIds,
  matches,
  sports,
  tournaments,
} from "@oddzilla/db";
import {
  SPORTRADAR_SPORT_IDS,
  sportradarSportIdFor,
} from "@oddzilla/types/sportradar";
import type { SportradarFixture } from "@oddzilla/types/sportradar";
import { BadRequestError } from "../errors.js";
import { proposeMappings, type OddzillaFixture } from "./matcher.js";
import {
  createStatsFixtureSource,
  type SportradarFixtureSource,
} from "./fixture-source.js";

/** How far back a match stays worth mapping. LMT is a LIVE tracker. */
const LOOKBACK_HOURS = 6;
/** How far ahead we bother pairing. Beyond this, kickoffs still move. */
const LOOKAHEAD_DAYS = 8;

/** The slice of the calendar a mapping is worth building for. */
export function importWindow(): { from: Date; to: Date } {
  const now = Date.now();
  return {
    from: new Date(now - LOOKBACK_HOURS * 3_600_000),
    to: new Date(now + LOOKAHEAD_DAYS * 86_400_000),
  };
}

/**
 * The distinct UTC days our own open matches for a sport fall on, so a
 * sweep fetches exactly the Sportradar days it can use.
 */
export async function openMatchDays(
  app: FastifyInstance,
  sportSlug: string,
): Promise<string[]> {
  const { from, to } = importWindow();
  const rows = await app.db
    .select({ day: sql<string>`DISTINCT to_char(${matches.scheduledAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')` })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .where(
      and(
        eq(sports.slug, sportSlug),
        inArray(matches.status, ["not_started", "live"]),
        gte(matches.scheduledAt, from),
        lte(matches.scheduledAt, to),
      ),
    );
  return rows.map((r) => r.day).sort();
}

export interface PersistResult {
  dryRun: boolean;
  fixturesParsed: number;
  parseErrors: Array<{ line: number; reason: string; raw: string }>;
  matchesConsidered: number;
  proposed: number;
  wouldAutoConfirm: number;
  queuedForReview: number;
  unmatched: number;
  preview: Array<Record<string, unknown>>;
  written?: number;
  skippedTaken?: number;
}

/**
 * Pair a batch of Sportradar fixtures against our open matches for one
 * sport and persist the result. Shared by the paste import and the
 * fetch-based sync so the two can never drift in what they accept.
 */
export async function matchAndPersist(
  app: FastifyInstance,
  opts: {
    sportSlug: string;
    fixtures: SportradarFixture[];
    dryRun: boolean;
    parseErrors: Array<{ line: number; reason: string; raw: string }>;
    /**
     * Present for an operator-initiated run. Omitted for the background
     * sweeper: admin_audit_log records what an ADMIN did, and a row with
     * no actor would both misrepresent that and leave the hash chain
     * hashing a NULL actor. The sweeper reports to the structured log
     * instead, like every other sweeper in this service.
     */
    audit?: { adminId: string; ip: string | null; action: string };
  },
): Promise<PersistResult> {
  const srSportId = sportradarSportIdFor(opts.sportSlug);
  if (srSportId === null) {
    throw new BadRequestError(
      `the Live Match Tracker has no coverage for "${opts.sportSlug}"`,
      "sport_not_covered_by_lmt",
    );
  }

  const { from, to } = importWindow();
  // Candidates: our matches in this sport, inside the window, that no
  // human has already ruled on. An `admin`-sourced row or a rejection
  // is a decision — the matcher does not get to overwrite either.
  const ourRows = await app.db
    .select({
      matchId: matches.id,
      homeTeam: matches.homeTeam,
      awayTeam: matches.awayTeam,
      scheduledAt: matches.scheduledAt,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .leftJoin(matchSportradarIds, eq(matchSportradarIds.matchId, matches.id))
    .where(
      and(
        eq(sports.slug, opts.sportSlug),
        inArray(matches.status, ["not_started", "live"]),
        gte(matches.scheduledAt, from),
        lte(matches.scheduledAt, to),
        sql`(${matchSportradarIds.matchId} IS NULL OR (${matchSportradarIds.source} = 'auto' AND ${matchSportradarIds.status} = 'candidate'))`,
      ),
    );

  const ourFixtures: OddzillaFixture[] = ourRows.map((r) => ({
    matchId: r.matchId.toString(),
    srSportId,
    scheduledAt: r.scheduledAt,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
  }));

  const proposals = proposeMappings(ourFixtures, opts.fixtures);
  const autoCount = proposals.filter((p) => p.autoConfirm).length;

  const preview = proposals.slice(0, 50).map((p) => {
    const ours = ourRows.find((r) => r.matchId.toString() === p.matchId);
    return {
      matchId: p.matchId,
      homeTeam: ours?.homeTeam ?? "",
      awayTeam: ours?.awayTeam ?? "",
      srMatchId: p.srMatchId,
      srHomeTeam: p.evidence.srHomeTeam,
      srAwayTeam: p.evidence.srAwayTeam,
      confidence: p.confidence,
      autoConfirm: p.autoConfirm,
      sidesSwapped: p.evidence.sidesSwapped,
    };
  });

  const summary: PersistResult = {
    dryRun: opts.dryRun,
    fixturesParsed: opts.fixtures.length,
    parseErrors: opts.parseErrors,
    matchesConsidered: ourFixtures.length,
    proposed: proposals.length,
    wouldAutoConfirm: autoCount,
    queuedForReview: proposals.length - autoCount,
    unmatched: ourFixtures.length - proposals.length,
    preview,
  };

  if (opts.dryRun || proposals.length === 0) return summary;

  let written = 0;
  let skippedTaken = 0;
  await app.db.transaction(async (tx) => {
    for (const p of proposals) {
      // A Sportradar fixture already claimed by a DIFFERENT match —
      // typically one an operator confirmed by hand — is left alone.
      // The partial unique index would reject the insert anyway;
      // checking first turns a failed batch into a reported skip.
      const [taken] = await tx
        .select({ matchId: matchSportradarIds.matchId })
        .from(matchSportradarIds)
        .where(
          and(
            eq(matchSportradarIds.srMatchId, BigInt(p.srMatchId)),
            sql`${matchSportradarIds.status} <> 'rejected'`,
            sql`${matchSportradarIds.matchId} <> ${BigInt(p.matchId)}`,
          ),
        )
        .limit(1);
      if (taken) {
        skippedTaken += 1;
        continue;
      }

      await tx
        .insert(matchSportradarIds)
        .values({
          matchId: BigInt(p.matchId),
          srMatchId: BigInt(p.srMatchId),
          srSportId: p.srSportId,
          status: p.autoConfirm ? "confirmed" : "candidate",
          source: "auto",
          confidence: p.confidence.toFixed(3),
          evidence: p.evidence,
        })
        .onConflictDoUpdate({
          target: matchSportradarIds.matchId,
          set: {
            srMatchId: BigInt(p.srMatchId),
            srSportId: p.srSportId,
            status: p.autoConfirm ? "confirmed" : "candidate",
            source: "auto",
            confidence: p.confidence.toFixed(3),
            evidence: p.evidence,
            updatedAt: new Date(),
          },
          // Belt and braces alongside the query above: never let an
          // automatic pass overwrite a human decision.
          setWhere: sql`${matchSportradarIds.source} = 'auto' AND ${matchSportradarIds.status} = 'candidate'`,
        });
      written += 1;
    }

    if (opts.audit) {
      await tx.insert(adminAuditLog).values({
        actorUserId: opts.audit.adminId,
        action: opts.audit.action,
        targetType: "sport",
        targetId: opts.sportSlug,
        beforeJson: null,
        afterJson: {
          fixtures: opts.fixtures.length,
          proposed: proposals.length,
          autoConfirmed: autoCount,
          written,
          skippedTaken,
        },
        ipInet: opts.audit.ip,
      });
    }
  });

  return { ...summary, written, skippedTaken };
}

export interface SyncSportResult {
  sportSlug: string;
  days: number;
  fixturesFetched: number;
  matchesConsidered: number;
  proposed: number;
  autoConfirmed: number;
  queuedForReview: number;
  written: number;
}

export interface SyncResult {
  dryRun: boolean;
  sports: SyncSportResult[];
  proposed: number;
  autoConfirmed: number;
  written: number;
  fetchErrors: string[];
}

/**
 * Fetch fixtures from Sportradar for the given sports and pair them.
 *
 * Only the days our own open matches actually fall on are fetched, so a
 * sport with nothing to map costs no requests at all, and a quiet
 * overnight sweep is a handful of calls rather than a crawl.
 */
export async function syncSports(
  app: FastifyInstance,
  opts: {
    sportSlugs: string[];
    dryRun: boolean;
    /** Omit for a system sweep — audit rows are for admin actions. */
    audit?: { adminId: string; ip: string | null; action: string };
    source?: SportradarFixtureSource;
  },
): Promise<SyncResult> {
  const source = opts.source ?? createStatsFixtureSource();
  const sportsOut: SyncSportResult[] = [];
  const fetchErrors: string[] = [];
  let written = 0;
  let autoConfirmed = 0;
  let proposed = 0;

  for (const slug of opts.sportSlugs) {
    const srSportId = sportradarSportIdFor(slug);
    if (srSportId === null) continue;

    const days = await openMatchDays(app, slug);
    if (days.length === 0) continue;

    const fixtures: SportradarFixture[] = [];
    for (const day of days) {
      try {
        fixtures.push(...(await source.fetchDay(srSportId, day)));
      } catch (err) {
        // One bad day must not abandon the rest of the sweep.
        fetchErrors.push(`${slug} ${day}: ${(err as Error).message}`);
      }
    }
    if (fixtures.length === 0) continue;

    const result = await matchAndPersist(app, {
      sportSlug: slug,
      fixtures,
      dryRun: opts.dryRun,
      parseErrors: [],
      ...(opts.audit ? { audit: opts.audit } : {}),
    });

    written += result.written ?? 0;
    autoConfirmed += result.wouldAutoConfirm;
    proposed += result.proposed;
    sportsOut.push({
      sportSlug: slug,
      days: days.length,
      fixturesFetched: fixtures.length,
      matchesConsidered: result.matchesConsidered,
      proposed: result.proposed,
      autoConfirmed: result.wouldAutoConfirm,
      queuedForReview: result.queuedForReview,
      written: result.written ?? 0,
    });
  }

  return {
    dryRun: opts.dryRun,
    sports: sportsOut,
    proposed,
    autoConfirmed,
    written,
    fetchErrors,
  };
}

/** Every sport the Live Match Tracker covers. */
export function lmtSportSlugs(): string[] {
  return Object.keys(SPORTRADAR_SPORT_IDS);
}
