package cc.oddzilla.app.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// ── Auth ──────────────────────────────────────────────────────────────

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val deviceId: String? = null,
)

@Serializable
data class SignupRequest(
    val email: String,
    val password: String,
    val displayName: String? = null,
    val countryCode: String? = null,
    val deviceId: String? = null,
)

@Serializable
data class AuthResponse(
    val user: AuthUserDto,
    val accessTokenExpiresAt: String,
)

@Serializable
data class AuthMeResponse(val user: AuthUserDto)

@Serializable
data class AuthUserDto(
    val id: String,
    val email: String,
    val role: String,
    val status: String,
    @SerialName("kycStatus") val kycStatus: String,
    val displayName: String? = null,
    val countryCode: String? = null,
)

// ── Catalog ───────────────────────────────────────────────────────────

@Serializable
data class SportsListResponse(val sports: List<SportSummary>)

@Serializable
data class SportSummary(
    val id: Int,
    val slug: String,
    val name: String,
    val logoUrl: String? = null,
    val brandColor: String? = null,
    val matchCount: Int? = null,
    val liveCount: Int? = null,
)

@Serializable
data class LiveCountsResponse(
    val counts: Map<String, Int>,
)

@Serializable
data class SportDetailResponse(
    val sport: SportSummary,
    val matches: List<MatchListItem>,
)

@Serializable
data class MatchesListResponse(
    val matches: List<MatchListItem>,
)

@Serializable
data class MatchListItem(
    val id: String,
    val scheduledAt: String? = null,
    val status: String,
    val homeTeam: String,
    val awayTeam: String,
    val homeLogoUrl: String? = null,
    val awayLogoUrl: String? = null,
    val tournamentName: String? = null,
    val tournamentRiskTier: Int? = null,
    val sportSlug: String,
    val sportName: String? = null,
    val matchWinner: MatchWinnerInline? = null,
)

@Serializable
data class MatchWinnerInline(
    val marketId: String,
    val home: OutcomeInline? = null,
    val away: OutcomeInline? = null,
)

@Serializable
data class OutcomeInline(
    val outcomeId: String,
    val odds: String? = null,
    val active: Boolean = true,
)

// Match detail. Response shape carries match + markets (grouped by
// scope on the client). Parsing is permissive — extra fields are
// ignored thanks to Json { ignoreUnknownKeys = true }.
@Serializable
data class MatchDetailResponse(
    val match: MatchHeader,
    val markets: List<MarketDto>,
)

@Serializable
data class MatchHeader(
    val id: String,
    val scheduledAt: String? = null,
    val status: String,
    val homeTeam: String,
    val awayTeam: String,
    val homeLogoUrl: String? = null,
    val awayLogoUrl: String? = null,
    val homeBrandColor: String? = null,
    val awayBrandColor: String? = null,
    val bestOf: Int? = null,
    val liveScore: JsonElement? = null,
    val tournamentId: Int? = null,
    val tournamentName: String? = null,
    val tournamentRiskTier: Int? = null,
    val sportId: Int,
    val sportSlug: String,
    val sportName: String,
    val streams: List<StreamSource> = emptyList(),
)

@Serializable
data class StreamSource(
    val platform: String,           // twitch | youtube | kick | gjirafa | other
    val embedId: String? = null,
    val url: String,
    val name: String? = null,
    val language: String? = null,
)

@Serializable
data class MarketDto(
    val id: String,
    val providerMarketId: Int,
    val name: String,
    val baseName: String? = null,
    val variant: String? = null,
    val status: Int,
    val scope: MarketScope? = null,
    val lineKey: String? = null,
    val lineSpec: String? = null,
    val lineValue: String? = null,
    val specifiers: Map<String, String> = emptyMap(),
    val outcomes: List<OutcomeDto> = emptyList(),
)

@Serializable
data class MarketScope(
    val id: String,
    val label: String,
    val order: Int = 0,
)

@Serializable
data class OutcomeDto(
    val outcomeId: String,
    val name: String,
    val publishedOdds: String? = null,
    val probability: String? = null,
    val active: Boolean = true,
)

// ── Wallet ────────────────────────────────────────────────────────────

@Serializable
data class WalletResponse(val wallets: List<WalletSnapshot>)

@Serializable
data class WalletSnapshot(
    val currency: String,
    val balanceMicro: String,
    val lockedMicro: String,
    val availableMicro: String,
)

@Serializable
data class WalletLedgerResponse(val entries: List<WalletLedgerEntry>)

@Serializable
data class WalletLedgerEntry(
    val id: String,
    val currency: String,
    val deltaMicro: String,
    val type: String,
    val refType: String? = null,
    val refId: String? = null,
    val txHash: String? = null,
    val memo: String? = null,
    val createdAt: String,
)

@Serializable
data class DepositAddressResponse(
    val address: DepositAddress? = null,
    val available: Boolean,
)

@Serializable
data class DepositAddress(
    val network: String,
    val address: String,
    val currency: String,
)

@Serializable
data class DepositIntentListResponse(val deposits: List<DepositIntent>)

@Serializable
data class LinkedWalletListResponse(val addresses: List<LinkedWalletAddress>)

@Serializable
data class LinkedWalletAddress(
    val id: String,
    val network: String,
    val address: String,
    val label: String? = null,
    val createdAt: String,
)

@Serializable
data class LinkedWalletRequest(
    val address: String,
    val label: String? = null,
)

@Serializable
data class DepositIntent(
    val id: String,
    val network: String,
    val txHash: String,
    val fromAddress: String? = null,
    val toAddress: String? = null,
    val amountMicro: String? = null,
    val confirmations: Int = 0,
    val confirmationsRequired: Int = 12,
    val status: String,
    val failureReason: String? = null,
    val submittedAt: String,
    val creditedAt: String? = null,
    val rejectedAt: String? = null,
)

@Serializable
data class WithdrawalRequest(
    val toAddress: String,
    val amountMicro: String,
)

@Serializable
data class WithdrawalListResponse(val withdrawals: List<Withdrawal>)

@Serializable
data class Withdrawal(
    val id: String,
    val network: String,
    val toAddress: String,
    val amountMicro: String,
    val feeMicro: String,
    val status: String,
    val txHash: String? = null,
    val requestedAt: String,
    val approvedAt: String? = null,
    val submittedAt: String? = null,
    val confirmedAt: String? = null,
    val failureReason: String? = null,
)

// ── Bets ──────────────────────────────────────────────────────────────

@Serializable
data class PlaceBetRequest(
    val stakeMicro: String,
    val idempotencyKey: String,
    val currency: String? = null,
    val betType: String? = null,
    val selections: List<PlaceBetSelection>,
)

@Serializable
data class PlaceBetSelection(
    val marketId: String,
    val outcomeId: String,
    val odds: String,
)

@Serializable
data class PlaceBetResponse(val ticket: TicketSummary)

@Serializable
data class TicketListResponse(val tickets: List<TicketSummary>)

@Serializable
data class TicketResponse(val ticket: TicketSummary)

@Serializable
data class TicketSummary(
    val id: String,
    val status: String,
    val betType: String,
    val currency: String,
    val stakeMicro: String,
    val potentialPayoutMicro: String,
    val actualPayoutMicro: String? = null,
    val notBeforeTs: String? = null,
    val rejectReason: String? = null,
    val placedAt: String,
    val acceptedAt: String? = null,
    val settledAt: String? = null,
    val betMeta: JsonElement? = null,
    val selections: List<TicketSelectionDto>,
)

@Serializable
data class TicketSelectionDto(
    val marketId: String,
    val outcomeId: String,
    val oddsAtPlacement: String,
    val probabilityAtPlacement: String? = null,
    val result: String? = null,
    val voidFactor: String? = null,
    val market: TicketMarketSnap? = null,
)

@Serializable
data class TicketMarketSnap(
    val providerMarketId: Int,
    val specifiers: Map<String, String> = emptyMap(),
    val matchId: String,
    val homeTeam: String,
    val awayTeam: String,
    val sportSlug: String,
)

// ── Cashout ───────────────────────────────────────────────────────────

@Serializable
data class CashoutQuoteResponse(val quote: CashoutQuote)

@Serializable
data class CashoutQuote(
    val available: Boolean,
    val reason: String? = null,
    val quoteId: String? = null,
    val offerMicro: String? = null,
    val ticketStakeMicro: String,
    val ticketOdds: String? = null,
    val probability: String? = null,
    val ticketValueFairMicro: String? = null,
    val deductionFactor: String? = null,
    val fullPayback: Boolean? = null,
    val expiresAt: String? = null,
    val acceptanceDelaySeconds: Int? = null,
)

@Serializable
data class CashoutAcceptRequest(
    val quoteId: String,
    val expectedOfferMicro: String,
)

@Serializable
data class CashoutAcceptResponse(
    val ticketId: String,
    val payoutMicro: String,
    val cashedOutAt: String,
)

// ── WebSocket frames ──────────────────────────────────────────────────

@Serializable
data class WsHello(
    val type: String,
    val userId: String? = null,
    val role: String? = null,
)

@Serializable
data class WsOddsFrame(
    val type: String,
    val matchId: String,
    val marketId: String,
    val providerMarketId: Int? = null,
    val specifiers: Map<String, String> = emptyMap(),
    val status: Int = 1,
    val outcomes: List<WsOddsOutcome> = emptyList(),
    val ts: Long = 0,
)

@Serializable
data class WsOddsOutcome(
    val outcomeId: String,
    val odds: String,
    val active: Boolean = true,
)

@Serializable
data class WsMatchStatusFrame(
    val type: String,
    val matchId: String,
    val status: String,
)

@Serializable
data class WsTicketFrame(
    val type: String,
    val ticketId: String,
    val status: String,
    val rejectReason: String? = null,
    val actualPayoutMicro: String? = null,
)

@Serializable
data class WsClientSubscribe(
    val type: String = "subscribe",
    val matchIds: List<String> = emptyList(),
)

@Serializable
data class WsClientUnsubscribe(
    val type: String = "unsubscribe",
    val matchIds: List<String> = emptyList(),
)

@Serializable
data class WsClientPing(val type: String = "ping")

// ── Community ─────────────────────────────────────────────────────────

@Serializable
data class CommunityFeedResponse(
    val tickets: List<CommunityTicketSummary>,
    val page: Int,
    val pageSize: Int,
    val hasMore: Boolean,
)

@Serializable
data class CommunityUserTicketsResponse(
    val nickname: String,
    val tickets: List<CommunityTicketSummary>,
    val page: Int,
    val pageSize: Int,
    val hasMore: Boolean,
)

@Serializable
data class CommunityTicketSummary(
    val ticketId: String,
    val nickname: String,
    val bio: String? = null,
    val currency: String,
    val status: String,           // accepted | settled | cashed_out | voided
    val betType: String,
    val stakeMicro: String,
    val payoutMicro: String,
    val profitMicro: String,
    val totalOdds: String,        // 4-decimal string
    val numLegs: Int,
    val sportIds: List<Int> = emptyList(),
    val inspirationCount: Int = 0,
    val avatarUrl: String? = null,
    val isBigWin: Boolean = false,
    val at: String,               // ISO-8601
)

@Serializable
data class CommunityProfile(
    val nickname: String,
    val bio: String? = null,
    val avatarUrl: String? = null,
    val joinedAt: String,
    val stats: CommunityProfileStats,
    val achievements: List<CommunityAchievement> = emptyList(),
)

@Serializable
data class CommunityProfileStats(
    val currency: String,
    val settledTickets: Int,
    val wins: Int,
    val winRatePct: Int,
    val roiPct: Int,
    val badgeCount: Int,
)

@Serializable
data class CommunityAchievement(
    val id: String,
    val title: String,
    val description: String,
    val icon: String,             // lucide-icon slug
    val unlockedAt: String,
)

@Serializable
data class CommunityCopyResponse(
    val currency: String,
    val betType: String,
    val selections: List<CommunityCopySelection>,
    val anyAvailable: Boolean,
)

@Serializable
data class CommunityCopySelection(
    val matchId: String,
    val marketId: String,
    val outcomeId: String,
    val odds: String,
    val homeTeam: String,
    val awayTeam: String,
    val marketLabel: String,
    val outcomeLabel: String,
    val sportSlug: String,
    val available: Boolean = true,
)

// ── Devices (push-notification registry) ──────────────────────────────

@Serializable
data class RegisterDeviceRequest(
    val token: String,
    val platform: String = "android",
    val appVersion: String? = null,
    val deviceLabel: String? = null,
)

@Serializable
data class UnregisterDeviceRequest(val token: String)

@Serializable
data class DevicesResponse(val devices: List<DeviceSummary>)

@Serializable
data class DeviceSummary(
    val id: String,
    val platform: String,
    val appVersion: String? = null,
    val deviceLabel: String? = null,
    val registeredAt: String,
    val lastSeenAt: String,
    val revokedAt: String? = null,
)

// ── Generic error ─────────────────────────────────────────────────────

@Serializable
data class ApiErrorBody(
    val error: String? = null,
    val message: String? = null,
)
