package cc.oddzilla.app.data.api

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

// Retrofit interface mirroring the subset of the Oddzilla REST API
// the mobile client needs. Method names match the route paths so it's
// trivial to grep across the codebase.

interface OddzillaApi {
    // ── Auth ──────────────────────────────────────────────────────
    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): AuthResponse

    @POST("auth/signup")
    suspend fun signup(@Body body: SignupRequest): AuthResponse

    @POST("auth/refresh")
    suspend fun refresh(): AuthResponse

    @POST("auth/logout")
    suspend fun logout()

    @GET("auth/me")
    suspend fun me(): AuthMeResponse

    // ── Catalog ───────────────────────────────────────────────────
    @GET("catalog/sports")
    suspend fun listSports(): SportsListResponse

    @GET("catalog/live-counts")
    suspend fun liveCounts(): LiveCountsResponse

    @GET("catalog/sports/{slug}")
    suspend fun getSport(
        @Path("slug") slug: String,
        @Query("tournament") tournamentId: Int? = null,
    ): SportDetailResponse

    @GET("catalog/matches")
    suspend fun listMatches(
        @Query("live") live: Boolean? = null,
        @Query("limit") limit: Int = 50,
    ): MatchesListResponse

    @GET("catalog/matches/{id}")
    suspend fun getMatch(@Path("id") id: String): MatchDetailResponse

    // ── Wallet ────────────────────────────────────────────────────
    @GET("wallet")
    suspend fun wallet(): WalletResponse

    @GET("wallet/ledger")
    suspend fun walletLedger(
        @Query("limit") limit: Int = 25,
        @Query("currency") currency: String? = null,
    ): WalletLedgerResponse

    @GET("wallet/deposit-address")
    suspend fun depositAddress(): DepositAddressResponse

    @GET("wallet/deposits")
    suspend fun listDeposits(@Query("limit") limit: Int = 50): DepositIntentListResponse

    @GET("wallet/addresses")
    suspend fun listLinkedWallets(): LinkedWalletListResponse

    @POST("wallet/addresses")
    suspend fun addLinkedWallet(@Body body: LinkedWalletRequest): LinkedWalletAddress

    @retrofit2.http.DELETE("wallet/addresses/{id}")
    suspend fun removeLinkedWallet(@Path("id") id: String)

    @GET("wallet/withdrawals")
    suspend fun listWithdrawals(@Query("limit") limit: Int = 50): WithdrawalListResponse

    @POST("wallet/withdrawals")
    suspend fun submitWithdrawal(@Body body: WithdrawalRequest): Withdrawal

    // ── Bets ──────────────────────────────────────────────────────
    @POST("bets")
    suspend fun placeBet(@Body body: PlaceBetRequest): PlaceBetResponse

    @GET("bets")
    suspend fun listBets(@Query("limit") limit: Int = 50): TicketListResponse

    @GET("bets/{id}")
    suspend fun getBet(@Path("id") id: String): TicketResponse

    // ── Cashout ───────────────────────────────────────────────────
    @GET("tickets/{id}/cashout/quote")
    suspend fun cashoutQuote(@Path("id") ticketId: String): CashoutQuoteResponse

    @POST("tickets/{id}/cashout")
    suspend fun cashoutAccept(
        @Path("id") ticketId: String,
        @Body body: CashoutAcceptRequest,
    ): CashoutAcceptResponse

    // ── Community ─────────────────────────────────────────────────
    @GET("community/feed")
    suspend fun communityFeed(
        @Query("sort") sort: String = "recent",       // recent | best
        @Query("currency") currency: String? = null,
        @Query("sport") sportSlug: String? = null,
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 20,
    ): CommunityFeedResponse

    @GET("community/users/{nickname}/profile")
    suspend fun communityProfile(
        @Path("nickname") nickname: String,
        @Query("currency") currency: String? = null,
    ): CommunityProfile

    @GET("community/users/{nickname}/tickets")
    suspend fun communityUserTickets(
        @Path("nickname") nickname: String,
        @Query("page") page: Int = 1,
        @Query("pageSize") pageSize: Int = 20,
    ): CommunityUserTicketsResponse

    @POST("community/copy/{communityTicketId}")
    suspend fun communityCopy(
        @Path("communityTicketId") communityTicketId: String,
    ): CommunityCopyResponse

    // ── Devices ───────────────────────────────────────────────────
    @POST("devices/register")
    suspend fun registerDevice(@Body body: RegisterDeviceRequest)

    @POST("devices/unregister")
    suspend fun unregisterDevice(@Body body: UnregisterDeviceRequest)

    @GET("devices")
    suspend fun listDevices(): DevicesResponse
}
