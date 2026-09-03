// GraphQL documents. Extracted from Bifrost's own bundle (v1.28.0) on
// 2026-09-03 — introspection is disabled on the endpoint, so the front
// end's queries are the only schema we have. The full catalogue of 66
// operations lives in docs/fixtures/bifrost-operations.graphql; these are
// the four the backup feed needs, trimmed to the fields it consumes.

package bifrost

// QueryAllMatch pages the non-historic esports timeline. Only ids and
// lifecycle fields: the runner subscribes per match for markets.
const QueryAllMatch = `query allMatch($after: String, $first: Int, $sportType: SportType, $historic: Boolean, $sort: SortType, $dateFrom: String, $dateTo: String) {
  allMatch(after: $after, first: $first, sportType: $sportType, historic: $historic, sort: $sort, dateFrom: $dateFrom, dateTo: $dateTo) {
    edges { node { id state datePlannedStart } }
    pageInfo { hasNextPage endCursor }
    total
  }
}`

// QueryMatch is the full match detail: every market group with every
// market and outcome, plus score, teams, tournament, sport and streams.
const QueryMatch = `query match($matchId: ID!, $historic: Boolean!) {
  match(id: $matchId, historic: $historic) {
    ...MatchDetail
  }
}
` + fragmentMatchDetail

// SubscriptionMatchLive pushes the same detail shape on every change,
// starting with an init snapshot (withInit: true). Works for every match
// state, not only live ones — verified against a NOT_STARTED and a
// CLOSED match on 2026-09-03.
const SubscriptionMatchLive = `subscription onUpdateMatchLive($matchId: ID!) {
  onUpdateMatchLive(matchId: $matchId, withInit: true) {
    ...MatchDetail
  }
}
` + fragmentMatchDetail

// SubscriptionMatchState is one global stream of lifecycle changes:
// new fixtures, kick-offs, closes, start-time and stream changes.
const SubscriptionMatchState = `subscription onMatchStateChanged {
  onMatchStateChanged {
    id
    datePlannedStart
    state
    prematchOnly
    stream { url streamProvider }
  }
}`

const fragmentMatchDetail = `fragment MatchDetail on Match {
  id
  datePlannedStart
  state
  prematchOnly
  categories
  teams { team { id name icon } winner }
  tournament { id name sport { id name icon } }
  marketGroups {
    id name namePrefix category layoutType order
    selections { id name }
    markets { id info state outcomes { id odds status } }
  }
  simpleScore {
    home away periodType activePeriodIdx totalPeriods
    periods { number home away }
  }
  allStreams { url locale name }
  stream { url streamProvider }
}`
