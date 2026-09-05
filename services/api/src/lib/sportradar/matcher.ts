// Pairing Oddzilla matches to Sportradar fixtures.
//
// Neither Oddin nor Fonbet carries a Sportradar id, so the link has to be
// inferred from the only two things both sides publish about a fixture:
// kickoff time and team names. That inference is what lives here — pure
// functions over plain data, so it can be unit-tested against real name
// pairs and reused whatever ends up SUPPLYING the Sportradar side.
//
// Three ideas do most of the work:
//
//  1. Kickoff is a GATE, not a score. Two providers listing the same
//     fixture agree on kickoff to within a couple of minutes; a pair more
//     than KICKOFF_GATE_MINUTES apart is not a candidate at any name
//     similarity. Inside the gate the delta only breaks ties.
//
//  2. Names are compared by TOKEN, with prefix-equality. "Man Utd" and
//     "Manchester United" share no whole token after normalisation, but
//     `man` is a prefix of `manchester` and `utd` expands to `united`, so
//     they score 1.0. Bare edit distance gets this badly wrong in both
//     directions.
//
//  3. Squad qualifiers are HARD discriminators, not weak signals. The
//     dangerous false positive in this domain is not "Real Madrid" vs
//     "Real Sociedad" — those score low and fall out on their own. It is
//     "Barcelona" vs "Barcelona W", or "Lokomotiv Moscow" vs "Lokomotiv
//     Moscow (youth)": near-identical names, same competition family,
//     often overlapping kickoffs. Those score ~1.0 on every text metric
//     and would auto-confirm. So a gender or age qualifier present on one
//     side and absent on the other zeroes the pair outright.
//
//     One exception, and it is per SPORT rather than per name. In an
//     individual sport a "team" is a person, and both providers write
//     people as surname + initials ("Tseng C H", "Harrison C / Skupski
//     N"). There a single letter is an initial, never a squad marker —
//     "Tseng C H" is not the C team of Tseng — so the one-letter markers
//     are switched off for the sports where Sportradar itself tracks
//     individuals. Measured on production 2026-09-05: every tennis, table
//     tennis, darts, badminton and padel player with an initial B, C or W
//     was being vetoed against their own Sportradar fixture (36 open
//     tennis fixtures alone), which is how "Samrej K vs Tseng C H" sat
//     unmapped 10 minutes from "Samrej, Kasidit vs Tseng, Chun Hsin".
//
//     And the two providers put the qualifier in DIFFERENT PLACES.
//     Fonbet marks the team ("Chelsea (w)", "Poland U20"); Sportradar's
//     day feed marks the competition ("Super League, Women", "U20 FIFA
//     World Cup") and names the team bare ("Chelsea", "Poland"). Compared
//     team-to-team that is marker-vs-none on every women's and youth
//     fixture — a veto — which is why women's football, handball,
//     volleyball, basketball and rugby paired at exactly zero (measured
//     2026-09-05: ~350 open fixtures, "Chelsea (w) vs Aston Villa (w)"
//     sitting beside "Chelsea vs Aston Villa" in "Super League, Women").
//     So `scorePair` restates the competition's qualifiers on the
//     Sportradar team names before comparing. Reserve sides need no such
//     help: both feeds name those on the team ("Porto B").
//
// Auto-confirmation additionally requires that the winner be clearly
// ahead of the runner-up (AMBIGUITY_MARGIN). A round of youth fixtures
// kicking off together in one league produces several near-identical
// candidates; when that happens the right answer is a human, not the
// higher of two coin flips.

import { sportradarSportIsIndividual } from "@oddzilla/types/sportradar";
import type {
  SportradarFixture,
  SportradarMatchEvidence,
} from "@oddzilla/types/sportradar";

/** A match on our side, as the matcher needs to see it. */
export interface OddzillaFixture {
  matchId: string;
  srSportId: number;
  /** Kickoff, ISO-8601 or Date. Matches without one cannot be paired. */
  scheduledAt: string | Date | null;
  homeTeam: string;
  awayTeam: string;
}

/** Kickoff times further apart than this are never the same fixture. */
export const KICKOFF_GATE_MINUTES = 20;
/** Auto-confirmation wants the two clocks to agree more tightly than the gate. */
export const KICKOFF_AUTO_MINUTES = 10;
/**
 * Below this, one side's name is too weak to propose the pair at all.
 *
 * Deliberately ABOVE 0.5, which is exactly what two two-word names
 * sharing one word score: "Manchester United" / "Newcastle United",
 * "Real Madrid" / "Real Sociedad". Those are the shape of the near-miss
 * this gate exists to reject, so the floor has to exclude, not include,
 * them. 0.6 still admits a genuine partial like "Bayern" against
 * "Bayern Munich" (0.67).
 */
export const MIN_TEAM_SCORE = 0.6;
/** Both names must be at least this strong to skip human review. */
export const AUTO_MIN_TEAM_SCORE = 0.8;
/** Overall score needed to skip human review. */
export const AUTO_CONFIRM_SCORE = 0.9;
/** A winner this close to the runner-up is ambiguous, whatever it scored. */
export const AMBIGUITY_MARGIN = 0.05;
/** Penalty for a pair that only agrees once home/away are swapped. */
const SWAP_PENALTY = 0.97;

// Club-type designators. Dropped because providers disagree about them
// freely ("FC Porto" / "Porto", "Real Sociedad" / "Real Sociedad CF").
// Geography and nicknames are NOT in here — "City" distinguishes
// Manchester City from Manchester United and must survive.
const DESIGNATORS = new Set([
  "fc", "cf", "afc", "sc", "ac", "ad", "cd", "ud", "sd", "rc", "cs", "as",
  "us", "ss", "ssc", "fk", "nk", "hk", "hc", "bk", "ik", "if", "sk", "gk", "kf",
  "cfc", "club", "calcio", "futbol", "futebol", "kulubu", "spor", "sport",
  "team", "the", "of", "and",
]);

// Token rewrites where two providers reliably use different spellings for
// the same thing.
const SYNONYMS: Record<string, string> = {
  utd: "united",
  st: "saint",
  ste: "saint",
  intl: "international",
  natl: "national",
  univ: "university",
};

// Age / reserve-squad qualifiers. Present on one side and absent on the
// other, these mean two DIFFERENT teams with the same name.
const AGE_MARKERS = new Set([
  "youth", "yth", "jr", "junior", "juniors", "juvenil", "reserves", "reserve",
  "res", "ii", "iii", "b", "c", "academy", "u14", "u15", "u16", "u17", "u18",
  "u19", "u20", "u21", "u22", "u23",
]);

// Women's-team qualifiers. Same reasoning, and the more common trap
// because the marker is often a single letter.
const GENDER_MARKERS = new Set([
  "w", "women", "womens", "ladies", "fem", "feminin", "feminino", "femenino",
  "frauen",
]);

export interface NameOptions {
  /**
   * The names are people (or doubles pairs), not clubs. A single-letter
   * token is then an initial and never a squad qualifier — see the file
   * header. `scorePair` derives it from the Sportradar sport id; a caller
   * comparing bare names gets club semantics, which is the safe default
   * because it can only refuse a pair, never invent one.
   */
  individual?: boolean;
}

/**
 * Lowercase, strip diacritics and punctuation, expand known synonyms,
 * drop club designators, and split off squad qualifiers.
 *
 * Qualifiers come back separately rather than as tokens because they are
 * scored differently — as a veto, not as similarity.
 */
export function normaliseTeamName(
  raw: string,
  opts: NameOptions = {},
): {
  tokens: string[];
  age: string | null;
  gender: string | null;
} {
  const flattened = raw
    .normalize("NFD")
    // Combining marks: "Málaga" → "Malaga", "Beşiktaş" → "Besiktas".
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    // Keep digits: "Schalke 04", "Basketball 3x3", "1899 Hoffenheim".
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

  const tokens: string[] = [];
  let age: string | null = null;
  let gender: string | null = null;

  for (const rawToken of flattened.split(" ")) {
    if (!rawToken) continue;
    const token = SYNONYMS[rawToken] ?? rawToken;
    // A person's initial. "Tseng C H" carries no reserve squad and
    // "Wang W" is not a women's side; both are one letter that the
    // marker sets below would otherwise read as a qualifier and veto.
    if (opts.individual && token.length === 1) {
      tokens.push(token);
      continue;
    }
    if (AGE_MARKERS.has(token)) {
      // Keep the FIRST qualifier seen; "Ajax II" and "Ajax B" both mean
      // "not the first team" without meaning the same squad.
      age ??= token;
      continue;
    }
    if (GENDER_MARKERS.has(token)) {
      gender ??= token;
      continue;
    }
    if (DESIGNATORS.has(token)) continue;
    tokens.push(token);
  }

  // A name made ENTIRELY of designators and qualifiers keeps its raw
  // tokens rather than becoming empty — better a weak comparison than a
  // vacuous one that matches everything.
  if (tokens.length === 0) {
    const fallback = flattened.split(" ").filter(Boolean);
    return { tokens: fallback, age, gender };
  }
  return { tokens, age, gender };
}

/**
 * Two tokens agree if they are equal, one is a >=3-char prefix of the
 * other, or one is a bare INITIAL for the other.
 *
 * The initial rule is what makes individual sports work at all. Fonbet
 * names a player "Hoshko N"; Sportradar names the same player
 * "Hoshko, Nazar". Without it those score 0.5 — one matched token out of
 * four — which sits just under MIN_TEAM_SCORE, and every tennis, table
 * tennis, darts and badminton fixture falls out. Measured against
 * production 2026-09-04: table tennis paired 0 of 541 before this rule.
 *
 * It does make "Smith J" agree with both "Smith, John" and "Smith, James".
 * That is handled where it belongs rather than here: both candidates then
 * score identically, and `proposeMappings` refuses to auto-confirm a
 * winner that its runner-up is within AMBIGUITY_MARGIN of, so the pair
 * goes to a human instead of to a coin flip.
 */
function tokensAgree(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1) return long.startsWith(short);
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Similarity of two team names in [0, 1].
 *
 * Returns 0 — not a low score, a refusal — when the two sides disagree
 * about whether this is a women's or a youth/reserve team. See the file
 * header.
 */
export function teamSimilarity(
  a: string,
  b: string,
  opts: NameOptions = {},
): number {
  const left = normaliseTeamName(a, opts);
  const right = normaliseTeamName(b, opts);

  // Qualifier veto. Present-vs-absent is a different team. Two DIFFERENT
  // qualifiers (say "youth" and "u19") are only a mild signal, because
  // the two providers draw from different vocabularies for the same
  // squad, so that case falls through to ordinary scoring.
  if ((left.age === null) !== (right.age === null)) return 0;
  if ((left.gender === null) !== (right.gender === null)) return 0;

  const used = new Array<boolean>(right.tokens.length).fill(false);
  let matched = 0;
  for (const token of left.tokens) {
    for (let i = 0; i < right.tokens.length; i += 1) {
      if (used[i]) continue;
      if (tokensAgree(token, right.tokens[i]!)) {
        used[i] = true;
        matched += 1;
        break;
      }
    }
  }
  const total = left.tokens.length + right.tokens.length;
  if (total === 0) return 0;
  // Dice over tokens: rewards matching a high share of BOTH names, so
  // "Bayern" against "Bayern Munich" scores 0.67 rather than 1.0 — a real
  // partial match, not a claimed certainty.
  return (2 * matched) / total;
}

// Words a competition name uses to say every side in it is a women's
// team. Sportradar's English-locale feed mostly appends ", Women", and
// keeps a handful of league names in their own language ("Primera
// Division Femenina"). Matched after diacritics are stripped, so
// "Féminine" reads as "feminine".
const WOMEN_COMPETITION_RE =
  /\b(women|womens|ladies|female|girls|femenin[ao]|feminin[ae]s?|frauen|damen|kvinner|kvinnor)\b/iu;
// Age groups a competition states for every side in it ("U20 FIFA World
// Cup", "Primavera 1"). Reserve markers are deliberately NOT read off a
// competition: "Serie B", "Group B" and "Pool B" are divisions, not
// squads, and both providers name a reserve side on the team anyway.
const AGE_COMPETITION_RE = /\bu-?(1[4-9]|2[0-3])\b/iu;
const YOUTH_COMPETITION_RE = /\b(youth|primavera)\b/iu;

/**
 * Squad qualifiers a competition name implies for every side in it.
 *
 * `ageGroup` comes back in the same vocabulary the team-name markers use
 * ("u20", "youth") so the two sides of the veto compare like with like.
 * Getting this wrong in either direction costs a pairing, never invents
 * one: an over-read marker vetoes a men's fixture, an under-read one
 * leaves a women's fixture where it was.
 */
export function qualifiersFromCompetition(name: string | undefined): {
  women: boolean;
  ageGroup: string | null;
} {
  if (!name) return { women: false, ageGroup: null };
  const flat = name.normalize("NFD").replace(/\p{Mn}/gu, "");
  const age = AGE_COMPETITION_RE.exec(flat);
  return {
    women: WOMEN_COMPETITION_RE.test(flat),
    ageGroup: age
      ? `u${age[1]}`
      : YOUTH_COMPETITION_RE.test(flat)
        ? "youth"
        : null,
  };
}

/**
 * Restate on a Sportradar team name the qualifiers its competition
 * carries, so "Chelsea" under "Super League, Women" meets Fonbet's
 * "Chelsea (w)" as two women's sides rather than as a veto. Idempotent
 * against a name that already carries the marker — `normaliseTeamName`
 * keeps only the first qualifier it sees.
 */
function withCompetitionQualifiers(team: string, fixture: SportradarFixture): string {
  const q = qualifiersFromCompetition(fixture.tournament);
  const extra: string[] = [];
  if (q.women) extra.push("w");
  if (q.ageGroup) extra.push(q.ageGroup);
  return extra.length === 0 ? team : `${team} ${extra.join(" ")}`;
}

export interface ScoredPair {
  score: number;
  homeScore: number;
  awayScore: number;
  kickoffDeltaMinutes: number;
  sidesSwapped: boolean;
}

/**
 * Score one (our match, SR fixture) pair, or null when the pair fails a
 * gate (different sport, kickoff too far apart, either name too weak).
 */
export function scorePair(
  ours: OddzillaFixture,
  theirs: SportradarFixture,
): ScoredPair | null {
  if (ours.srSportId !== theirs.srSportId) return null;
  if (ours.scheduledAt == null) return null;

  const ourKickoff = new Date(ours.scheduledAt).getTime();
  const theirKickoff = new Date(theirs.startsAt).getTime();
  if (!Number.isFinite(ourKickoff) || !Number.isFinite(theirKickoff)) return null;

  const deltaMinutes = Math.abs(ourKickoff - theirKickoff) / 60_000;
  if (deltaMinutes > KICKOFF_GATE_MINUTES) return null;

  // Same sport on both sides (checked above), so the sport id decides
  // once whether these names are clubs or people.
  const names: NameOptions = {
    individual: sportradarSportIsIndividual(theirs.srSportId),
  };
  // Clubs get the qualifiers their competition implies (see the file
  // header). People do not: a player in a women's draw is not marked on
  // either feed, and a bare "w" in individual mode would read as an
  // initial and dilute the score.
  const theirHome = names.individual
    ? theirs.homeTeam
    : withCompetitionQualifiers(theirs.homeTeam, theirs);
  const theirAway = names.individual
    ? theirs.awayTeam
    : withCompetitionQualifiers(theirs.awayTeam, theirs);
  const direct = {
    home: teamSimilarity(ours.homeTeam, theirHome, names),
    away: teamSimilarity(ours.awayTeam, theirAway, names),
  };
  const swapped = {
    home: teamSimilarity(ours.homeTeam, theirAway, names),
    away: teamSimilarity(ours.awayTeam, theirHome, names),
  };
  const directMean = (direct.home + direct.away) / 2;
  const swappedMean = (swapped.home + swapped.away) / 2;
  const useSwapped = swappedMean > directMean;
  const chosen = useSwapped ? swapped : direct;

  if (chosen.home < MIN_TEAM_SCORE || chosen.away < MIN_TEAM_SCORE) return null;

  const nameScore = (chosen.home + chosen.away) / 2;
  // Kickoff contributes only as a tiebreaker inside the gate: 1.0 at
  // exact agreement, falling linearly to 0 at the gate.
  const kickoffScore = 1 - deltaMinutes / KICKOFF_GATE_MINUTES;
  let score = 0.85 * nameScore + 0.15 * kickoffScore;
  if (useSwapped) score *= SWAP_PENALTY;

  return {
    score,
    homeScore: chosen.home,
    awayScore: chosen.away,
    kickoffDeltaMinutes: deltaMinutes,
    sidesSwapped: useSwapped,
  };
}

export interface MatchProposal {
  matchId: string;
  srMatchId: number;
  srSportId: number;
  confidence: number;
  autoConfirm: boolean;
  evidence: SportradarMatchEvidence;
}

/**
 * Pair a set of our matches against a set of Sportradar fixtures.
 *
 * Greedy global assignment: every viable pair is scored, then taken best
 * first, skipping any match or fixture already claimed. That is not
 * optimal in the Hungarian sense, but it is deterministic, O(n·m log n·m),
 * and on this data the optimum and the greedy result differ only where
 * the pairs were ambiguous enough to need review anyway.
 */
export function proposeMappings(
  ourMatches: readonly OddzillaFixture[],
  srFixtures: readonly SportradarFixture[],
): MatchProposal[] {
  interface Candidate {
    ours: OddzillaFixture;
    theirs: SportradarFixture;
    scored: ScoredPair;
  }

  const candidates: Candidate[] = [];
  for (const ours of ourMatches) {
    for (const theirs of srFixtures) {
      const scored = scorePair(ours, theirs);
      if (scored) candidates.push({ ours, theirs, scored });
    }
  }

  // Runners-up per match, computed before anything is claimed, so the
  // ambiguity check reflects the real field of candidates rather than
  // what greedy assignment happened to leave behind.
  const byMatch = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byMatch.get(c.ours.matchId);
    if (list) list.push(c);
    else byMatch.set(c.ours.matchId, [c]);
  }
  for (const list of byMatch.values()) {
    list.sort((a, b) => b.scored.score - a.scored.score);
  }

  candidates.sort((a, b) => {
    if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
    // Stable, id-ordered tiebreak so two runs over the same input agree.
    if (a.ours.matchId !== b.ours.matchId) {
      return a.ours.matchId < b.ours.matchId ? -1 : 1;
    }
    return a.theirs.srMatchId - b.theirs.srMatchId;
  });

  const takenMatches = new Set<string>();
  const takenFixtures = new Set<number>();
  const proposals: MatchProposal[] = [];

  for (const { ours, theirs, scored } of candidates) {
    if (takenMatches.has(ours.matchId)) continue;
    if (takenFixtures.has(theirs.srMatchId)) continue;
    takenMatches.add(ours.matchId);
    takenFixtures.add(theirs.srMatchId);

    const field = byMatch.get(ours.matchId) ?? [];
    const runnerUp = field.find((c) => c.theirs.srMatchId !== theirs.srMatchId);
    const unambiguous =
      runnerUp === undefined ||
      scored.score - runnerUp.scored.score >= AMBIGUITY_MARGIN;

    const autoConfirm =
      unambiguous &&
      scored.score >= AUTO_CONFIRM_SCORE &&
      scored.homeScore >= AUTO_MIN_TEAM_SCORE &&
      scored.awayScore >= AUTO_MIN_TEAM_SCORE &&
      scored.kickoffDeltaMinutes <= KICKOFF_AUTO_MINUTES;

    proposals.push({
      matchId: ours.matchId,
      srMatchId: theirs.srMatchId,
      srSportId: theirs.srSportId,
      confidence: Math.round(scored.score * 1000) / 1000,
      autoConfirm,
      evidence: {
        srHomeTeam: theirs.homeTeam,
        srAwayTeam: theirs.awayTeam,
        srStartsAt: theirs.startsAt,
        ...(theirs.tournament ? { srTournament: theirs.tournament } : {}),
        kickoffDeltaMinutes: Math.round(scored.kickoffDeltaMinutes * 10) / 10,
        homeScore: Math.round(scored.homeScore * 1000) / 1000,
        awayScore: Math.round(scored.awayScore * 1000) / 1000,
        sidesSwapped: scored.sidesSwapped,
        ...(field.length > 1
          ? {
              alternatives: field
                .filter((c) => c.theirs.srMatchId !== theirs.srMatchId)
                .slice(0, 3)
                .map((c) => ({
                  srMatchId: c.theirs.srMatchId,
                  score: Math.round(c.scored.score * 1000) / 1000,
                  homeTeam: c.theirs.homeTeam,
                  awayTeam: c.theirs.awayTeam,
                })),
            }
          : {}),
      },
    });
  }

  return proposals;
}
