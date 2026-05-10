package cc.oddzilla.app.ui.screens.wallet

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.common.decimalToMicro
import cc.oddzilla.app.common.formatMoney
import cc.oddzilla.app.data.api.DepositAddress
import cc.oddzilla.app.data.api.DepositIntent
import cc.oddzilla.app.data.api.LinkedWalletAddress
import cc.oddzilla.app.data.api.WalletSnapshot
import cc.oddzilla.app.data.api.Withdrawal
import cc.oddzilla.app.ui.components.OzPrimaryButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@Composable
fun WalletScreen() {
    val deps = LocalDeps.current
    val scope = rememberCoroutineScope()
    val colors = OzTheme.colors

    var balances by remember { mutableStateOf<List<WalletSnapshot>>(emptyList()) }
    var depositAddress by remember { mutableStateOf<DepositAddress?>(null) }
    var deposits by remember { mutableStateOf<List<DepositIntent>>(emptyList()) }
    var linkedWallets by remember { mutableStateOf<List<LinkedWalletAddress>>(emptyList()) }
    var withdrawals by remember { mutableStateOf<List<Withdrawal>>(emptyList()) }
    var refreshing by remember { mutableStateOf(false) }

    suspend fun load() {
        try {
            balances = deps.walletRepository.balances()
            depositAddress = deps.walletRepository.depositAddress().address
            deposits = deps.walletRepository.deposits()
            linkedWallets = deps.walletRepository.linkedWallets()
            withdrawals = deps.walletRepository.withdrawals()
        } catch (e: Throwable) {
            deps.snackbar.show(e.message ?: "Could not load wallet.")
        }
    }
    LaunchedEffect(Unit) { load() }

    OzPullToRefresh(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch { load(); refreshing = false }
        },
        modifier = Modifier.fillMaxSize().background(colors.bg),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            BalanceSection(balances = balances)
            DepositSection(
                address = depositAddress,
                deposits = deposits,
                linkedWallets = linkedWallets,
                onAddLinkedWallet = { addr, label ->
                    scope.launch {
                        runCatching { deps.walletRepository.addLinkedWallet(addr, label) }
                            .onSuccess {
                                deps.snackbar.show("Sending wallet linked. Future deposits auto-credit.")
                                load()
                            }
                            .onFailure { deps.snackbar.show(it.message ?: "Could not link wallet.") }
                    }
                },
                onRemoveLinkedWallet = { id ->
                    scope.launch {
                        runCatching { deps.walletRepository.removeLinkedWallet(id) }
                            .onSuccess { deps.snackbar.show("Sending wallet removed."); load() }
                            .onFailure { deps.snackbar.show(it.message ?: "Could not remove wallet.") }
                    }
                },
            )
            WithdrawSection(
                balances = balances,
                withdrawals = withdrawals,
                onSubmit = { toAddress, amountDecimal ->
                    val micro = decimalToMicro(amountDecimal) ?: return@WithdrawSection false
                    scope.launch {
                        runCatching { deps.walletRepository.submitWithdrawal(toAddress, micro) }
                            .onSuccess {
                                deps.snackbar.show("Withdrawal submitted for review.")
                                load()
                            }
                            .onFailure { deps.snackbar.show(it.message ?: "Could not submit withdrawal.") }
                    }
                    true
                },
            )
        }
    }
}

@Composable
private fun BalanceSection(balances: List<WalletSnapshot>) {
    val colors = OzTheme.colors
    Column {
        Text("Balances", style = MaterialTheme.typography.titleLarge, color = colors.fg)
        Spacer(Modifier.height(8.dp))
        if (balances.isEmpty()) {
            Text("Loading…", color = colors.fgMuted, style = MaterialTheme.typography.bodyMedium)
            return
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            balances.forEach { w ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.surface)
                        .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(12.dp))
                        .padding(14.dp),
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(w.currency, style = MaterialTheme.typography.titleMedium, color = colors.fg)
                        Text(
                            "Available ${formatMoney(w.availableMicro, w.currency)}",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.fgMuted,
                        )
                    }
                    Text(
                        formatMoney(w.balanceMicro, w.currency),
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.fg,
                    )
                }
            }
        }
    }
}

@Composable
private fun DepositSection(
    address: DepositAddress?,
    deposits: List<DepositIntent>,
    linkedWallets: List<LinkedWalletAddress>,
    onAddLinkedWallet: (address: String, label: String?) -> Unit,
    onRemoveLinkedWallet: (id: String) -> Unit,
) {
    val colors = OzTheme.colors
    var newAddress by remember { mutableStateOf("") }
    var newLabel by remember { mutableStateOf("") }
    val clipboard: ClipboardManager = LocalClipboardManager.current

    Column {
        Text("Deposit", style = MaterialTheme.typography.titleLarge, color = colors.fg)
        Spacer(Modifier.height(8.dp))
        if (address == null) {
            Text(
                "Deposits are temporarily unavailable.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.fgMuted,
            )
        } else {
            Text(
                "Send ${address.currency} on ${address.network} to:",
                style = MaterialTheme.typography.labelMedium,
                color = colors.fgMuted,
            )
            Spacer(Modifier.height(4.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.surface)
                    .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(10.dp))
                    .padding(12.dp),
            ) {
                ClickableText(
                    text = AnnotatedString(address.address),
                    style = MaterialTheme.typography.bodyMedium.copy(color = colors.fg),
                    onClick = { clipboard.setText(AnnotatedString(address.address)) },
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Tap to copy. Deposits from a wallet you've linked below auto-credit; unlinked sends fall through to admin review.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.fgDim,
            )
            Spacer(Modifier.height(16.dp))

            // ── Linked sending wallets ─────────────────────────────
            Text(
                "Linked sending wallets",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )
            Spacer(Modifier.height(6.dp))
            if (linkedWallets.isEmpty()) {
                Text(
                    "No wallets linked yet. Add one below so deposits from it auto-credit to your balance.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fgMuted,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    linkedWallets.forEach { w ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(colors.surface)
                                .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(10.dp))
                                .padding(10.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    w.label?.takeIf { it.isNotBlank() } ?: w.address.take(10) + "…" + w.address.takeLast(6),
                                    style = MaterialTheme.typography.titleSmall,
                                    color = colors.fg,
                                )
                                Text(
                                    "${w.network}  ·  ${w.address.take(10)}…${w.address.takeLast(6)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.fgDim,
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(percent = 50))
                                    .background(colors.surface2)
                                    .clickable(onClickLabel = "Remove sending wallet") { onRemoveLinkedWallet(w.id) }
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                            ) {
                                Text("Remove", style = MaterialTheme.typography.labelMedium, color = colors.negative)
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = newAddress,
                onValueChange = { newAddress = it.trim() },
                label = { Text("Sending wallet address (0x… 40 hex)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = newLabel,
                onValueChange = { newLabel = it },
                label = { Text("Label (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OzPrimaryButton(
                text = "Link wallet",
                modifier = Modifier.fillMaxWidth(),
                enabled = newAddress.matches(Regex("^0x[0-9a-fA-F]{40}$")),
                onClick = {
                    onAddLinkedWallet(newAddress, newLabel.takeIf { it.isNotBlank() })
                    newAddress = ""
                    newLabel = ""
                },
            )
        }

        Spacer(Modifier.height(16.dp))
        if (deposits.isNotEmpty()) {
            Text(
                "Recent deposits",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fgMuted,
            )
            Spacer(Modifier.height(6.dp))
            deposits.take(5).forEach { d ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(
                        d.txHash.take(14) + "…",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "${d.confirmations}/${d.confirmationsRequired}",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fgMuted,
                    )
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Text(
                        d.status,
                        style = MaterialTheme.typography.bodySmall,
                        color = when (d.status) {
                            "credited" -> colors.positive
                            "rejected" -> colors.negative
                            else -> colors.fgMuted
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun WithdrawSection(
    balances: List<WalletSnapshot>,
    withdrawals: List<Withdrawal>,
    onSubmit: (toAddress: String, amount: String) -> Boolean,
) {
    val colors = OzTheme.colors
    var amount by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }

    val usdc = balances.firstOrNull { it.currency == "USDC" }

    Column {
        Text("Withdraw", style = MaterialTheme.typography.titleLarge, color = colors.fg)
        Spacer(Modifier.height(4.dp))
        Text(
            "USDC on ERC20 only.${usdc?.let { "  Available ${formatMoney(it.availableMicro, "USDC")}." } ?: ""}",
            style = MaterialTheme.typography.labelMedium,
            color = colors.fgMuted,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = amount,
            onValueChange = { amount = it.filter { c -> c.isDigit() || c == '.' } },
            label = { Text("Amount (USDC)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = address,
            onValueChange = { address = it.trim() },
            label = { Text("Destination address") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))
        OzPrimaryButton(
            text = "Request withdrawal",
            modifier = Modifier.fillMaxWidth(),
            enabled = amount.isNotBlank() && address.length >= 16,
            onClick = {
                if (onSubmit(address, amount)) {
                    amount = ""
                    address = ""
                }
            },
        )
        Spacer(Modifier.height(12.dp))
        if (withdrawals.isNotEmpty()) {
            Text(
                "Recent withdrawals",
                style = MaterialTheme.typography.titleMedium,
                color = colors.fgMuted,
            )
            Spacer(Modifier.height(6.dp))
            withdrawals.take(5).forEach { w ->
                Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(
                        formatMoney(w.amountMicro, "USDC"),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        w.toAddress.take(8) + "…" + w.toAddress.takeLast(4),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fgMuted,
                    )
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    Text(
                        w.status,
                        style = MaterialTheme.typography.bodySmall,
                        color = when (w.status) {
                            "confirmed" -> colors.positive
                            "failed", "cancelled" -> colors.negative
                            else -> colors.fgMuted
                        },
                    )
                }
            }
        }
    }
}

