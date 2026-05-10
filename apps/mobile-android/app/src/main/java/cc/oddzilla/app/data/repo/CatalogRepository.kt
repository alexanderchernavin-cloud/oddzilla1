package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.MatchDetailResponse
import cc.oddzilla.app.data.api.MatchListItem
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.SportDetailResponse
import cc.oddzilla.app.data.api.SportSummary

class CatalogRepository(private val api: OddzillaApi) {
    suspend fun listSports(): List<SportSummary> = api.listSports().sports
    suspend fun liveCounts(): Map<String, Int> = api.liveCounts().counts

    suspend fun getSport(slug: String, tournamentId: Int? = null): SportDetailResponse =
        api.getSport(slug, tournamentId)

    suspend fun listMatches(live: Boolean? = null, limit: Int = 50): List<MatchListItem> =
        api.listMatches(live = live, limit = limit).matches

    suspend fun getMatch(id: String): MatchDetailResponse = api.getMatch(id)
}
