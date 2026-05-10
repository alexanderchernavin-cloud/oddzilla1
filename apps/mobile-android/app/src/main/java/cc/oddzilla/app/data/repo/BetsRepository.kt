package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.CashoutAcceptRequest
import cc.oddzilla.app.data.api.CashoutAcceptResponse
import cc.oddzilla.app.data.api.CashoutQuote
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.PlaceBetRequest
import cc.oddzilla.app.data.api.PlaceBetSelection
import cc.oddzilla.app.data.api.TicketSummary
import java.util.UUID

class BetsRepository(private val api: OddzillaApi) {

    suspend fun place(
        currency: String,
        stakeMicro: String,
        betType: String,
        selections: List<PlaceBetSelection>,
    ): TicketSummary {
        val req = PlaceBetRequest(
            stakeMicro = stakeMicro,
            idempotencyKey = UUID.randomUUID().toString(),
            currency = currency,
            betType = betType,
            selections = selections,
        )
        return api.placeBet(req).ticket
    }

    suspend fun list(limit: Int = 50): List<TicketSummary> = api.listBets(limit).tickets

    suspend fun get(id: String): TicketSummary = api.getBet(id).ticket

    suspend fun cashoutQuote(ticketId: String): CashoutQuote = api.cashoutQuote(ticketId).quote

    suspend fun cashoutAccept(
        ticketId: String,
        quoteId: String,
        expectedOfferMicro: String,
    ): CashoutAcceptResponse =
        api.cashoutAccept(
            ticketId,
            CashoutAcceptRequest(quoteId = quoteId, expectedOfferMicro = expectedOfferMicro),
        )
}
