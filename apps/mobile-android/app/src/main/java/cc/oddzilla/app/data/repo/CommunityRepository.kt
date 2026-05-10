package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.CommunityCopyResponse
import cc.oddzilla.app.data.api.CommunityFeedResponse
import cc.oddzilla.app.data.api.CommunityProfile
import cc.oddzilla.app.data.api.CommunityUserTicketsResponse
import cc.oddzilla.app.data.api.OddzillaApi

class CommunityRepository(private val api: OddzillaApi) {

    suspend fun feed(
        sort: String = "recent",
        currency: String? = null,
        sportSlug: String? = null,
        page: Int = 1,
    ): CommunityFeedResponse =
        api.communityFeed(sort = sort, currency = currency, sportSlug = sportSlug, page = page)

    suspend fun profile(nickname: String, currency: String? = null): CommunityProfile =
        api.communityProfile(nickname, currency)

    suspend fun userTickets(nickname: String, page: Int = 1): CommunityUserTicketsResponse =
        api.communityUserTickets(nickname, page)

    suspend fun copy(communityTicketId: String): CommunityCopyResponse =
        api.communityCopy(communityTicketId)
}
