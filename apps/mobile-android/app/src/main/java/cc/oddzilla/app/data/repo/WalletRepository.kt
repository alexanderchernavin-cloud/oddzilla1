package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.DepositAddressResponse
import cc.oddzilla.app.data.api.DepositIntent
import cc.oddzilla.app.data.api.LinkedWalletAddress
import cc.oddzilla.app.data.api.LinkedWalletRequest
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.WalletLedgerEntry
import cc.oddzilla.app.data.api.WalletSnapshot
import cc.oddzilla.app.data.api.Withdrawal
import cc.oddzilla.app.data.api.WithdrawalRequest

class WalletRepository(private val api: OddzillaApi) {

    suspend fun balances(): List<WalletSnapshot> = api.wallet().wallets

    suspend fun ledger(currency: String? = null, limit: Int = 25): List<WalletLedgerEntry> =
        api.walletLedger(limit, currency).entries

    suspend fun depositAddress(): DepositAddressResponse = api.depositAddress()

    suspend fun deposits(): List<DepositIntent> = api.listDeposits().deposits

    /**
     * The user's whitelisted sending wallets. Deposits arriving from
     * one of these addresses get auto-attributed to the user by the
     * wallet-watcher; deposits from unlinked senders fall through to
     * admin review.
     */
    suspend fun linkedWallets(): List<LinkedWalletAddress> = api.listLinkedWallets().addresses

    suspend fun addLinkedWallet(address: String, label: String? = null): LinkedWalletAddress =
        api.addLinkedWallet(LinkedWalletRequest(address = address, label = label))

    suspend fun removeLinkedWallet(id: String) = api.removeLinkedWallet(id)

    suspend fun withdrawals(): List<Withdrawal> = api.listWithdrawals().withdrawals

    suspend fun submitWithdrawal(toAddress: String, amountMicro: String): Withdrawal =
        api.submitWithdrawal(WithdrawalRequest(toAddress = toAddress, amountMicro = amountMicro))
}
