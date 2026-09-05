// Sportradar match mapping — shared wire types plus the sport taxonomy
// bridge between our sport slugs and Sportradar's numeric sport ids.
//
// The Live Match Tracker takes TWO ids: the SR match id and the SR sport
// id. The match id has to be mapped per fixture (see migration 0100); the
// sport id is a fixed table, reproduced below.
//
// Where the numbers come from: Sportradar's own LMT demo bundle
// (widgets.sir.sportradar.com/assets/js/entry.demo_client.*.js) carries
// the id → slug table it uses to pick pitch art, read verbatim
// 2026-09-04:
//
//   1 soccer · 2 basketball · 3 baseball · 4 ice_hockey · 5 tennis
//   6 handball · 12 rugby · 16 american_football · 19 snooker
//   20 table_tennis · 21 cricket · 22 darts · 23 volleyball · 29 futsal
//   31 badminton · 34 beach_volley · 37 squash · 71 padel
//   137 esoccer · 138 kabadi · 153 ebasketball
//
// That list is also the LMT COVERAGE list — a sport absent from it has no
// tracker, which is why this map doubles as the storefront's "can this
// sport show LMT at all" predicate. Sports we carry that LMT does not
// cover (motorsport, chess, cycling, boxing, MMA, bandy, water polo,
// floorball, lacrosse, aussie rules, gaelic sports, 3x3 basketball,
// beach soccer, specials) are deliberately absent rather than mapped to
// a near-neighbour: a wrong sport id renders the wrong pitch.

/** Our sport slug → Sportradar sport id, for the sports LMT covers. */
export const SPORTRADAR_SPORT_IDS: Readonly<Record<string, number>> = {
  // Traditional sports, as slugged by fonbet-ingester's root-sport table
  // (services/fonbet-ingester/internal/mapper/sports.go).
  football: 1,
  basketball: 2,
  baseball: 3,
  "ice-hockey": 4,
  tennis: 5,
  handball: 6,
  rugby: 12,
  "american-football": 16,
  "table-tennis": 20,
  cricket: 21,
  darts: 22,
  volleyball: 23,
  futsal: 29,
  badminton: 31,
  "beach-volleyball": 34,
  squash: 37,
  padel: 71,
  // Esports LMT does cover, under Oddin's slugs. Not wired into the
  // storefront today (the tracker is a traditional-sport feature), but a
  // mapped row would render correctly if an operator adds one.
  efootball: 137,
  ebasketball: 153,
} as const;

/** Sportradar sport id for one of our sport slugs, or null when LMT has no tracker for it. */
export function sportradarSportIdFor(sportSlug: string): number | null {
  return SPORTRADAR_SPORT_IDS[sportSlug] ?? null;
}

/** True when the Live Match Tracker covers this sport at all. */
export function lmtCoversSport(sportSlug: string): boolean {
  return sportradarSportIdFor(sportSlug) !== null;
}

/**
 * Sportradar sports where the two sides of a fixture are PEOPLE (or a
 * doubles pair), not clubs: tennis, snooker, table tennis, darts,
 * badminton, squash, padel. The matcher reads names differently here —
 * a single-letter token is an initial ("Tseng C H", "Harrison C /
 * Skupski N"), never the reserve-squad or women's-side marker it is in
 * a club name ("Atletico Madrid C", "Lens W"). Kept beside the sport
 * table because it is the same taxonomy: an id absent from
 * SPORTRADAR_SPORT_IDS can never be looked up here.
 */
export const SPORTRADAR_INDIVIDUAL_SPORT_IDS: ReadonlySet<number> = new Set([
  5, 19, 20, 22, 31, 37, 71,
]);

/** True when Sportradar's sport id names an individual sport (see above). */
export function sportradarSportIsIndividual(srSportId: number): boolean {
  return SPORTRADAR_INDIVIDUAL_SPORT_IDS.has(srSportId);
}

export type SportradarMapStatus = "candidate" | "confirmed" | "rejected";
export type SportradarMapSource = "admin" | "auto";

/**
 * What the storefront needs to mount the tracker. Served on the match
 * detail payload, and null unless a CONFIRMED mapping exists.
 */
export interface SportradarMatchRef {
  srMatchId: number;
  srSportId: number;
}

/**
 * One fixture as Sportradar describes it — the input side of the matcher.
 * Deliberately source-agnostic: whatever supplies these (an operator
 * paste, a licensed API once Sportradar issues the Client ID) produces
 * the same shape, and the matcher never learns where they came from.
 */
export interface SportradarFixture {
  srMatchId: number;
  srSportId: number;
  /** Kickoff, ISO-8601. */
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  /**
   * Competition name. Shown to reviewers, and read by the matcher for the
   * squad qualifiers Sportradar states at competition level rather than
   * on the team — its day feed names a women's side "Chelsea" under
   * "Super League, Women", where Fonbet writes "Chelsea (w)". Never
   * scored as similarity.
   */
  tournament?: string;
}

/** Per-component scores behind a proposed pair, stored as evidence. */
export interface SportradarMatchEvidence {
  srHomeTeam: string;
  srAwayTeam: string;
  srStartsAt: string;
  srTournament?: string;
  /** Minutes between the two kickoff times (absolute). */
  kickoffDeltaMinutes: number;
  homeScore: number;
  awayScore: number;
  /** Whether the pair only agreed once home/away were swapped. */
  sidesSwapped: boolean;
  /** Runners-up, best first, for a reviewer deciding a close call. */
  alternatives?: Array<{
    srMatchId: number;
    score: number;
    homeTeam: string;
    awayTeam: string;
  }>;
}
