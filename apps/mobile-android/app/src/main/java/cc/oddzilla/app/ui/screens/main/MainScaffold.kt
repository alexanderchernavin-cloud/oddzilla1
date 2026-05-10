package cc.oddzilla.app.ui.screens.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.R
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.ui.screens.account.AccountScreen
import cc.oddzilla.app.ui.screens.bets.BetsScreen
import cc.oddzilla.app.ui.screens.community.CommunityFeedScreen
import cc.oddzilla.app.ui.screens.sports.SportsListScreen
import cc.oddzilla.app.ui.screens.wallet.WalletScreen
import cc.oddzilla.app.ui.theme.OzTheme

private enum class Tab(val labelRes: Int, val icon: ImageVector) {
    Sports(R.string.nav_sports, Icons.Outlined.SportsEsports),
    Community(R.string.nav_community, Icons.Outlined.Forum),
    Bets(R.string.nav_bets, Icons.Outlined.ReceiptLong),
    Wallet(R.string.nav_wallet, Icons.Outlined.AccountBalanceWallet),
    Account(R.string.nav_account, Icons.Outlined.AccountCircle),
}

// Shell that hosts the five bottom-tabs. Pushes to sport/match/profile
// are delegated to the parent NavHost via callbacks so the back stack
// stays at the auth-scope level (logout pops everything).

@Composable
fun MainScaffold(
    onNavigateSport: (slug: String) -> Unit,
    onNavigateProfile: (nickname: String) -> Unit,
    onOpenSlip: () -> Unit,
) {
    val deps = LocalDeps.current
    val colors = OzTheme.colors
    var selected by rememberSaveable { mutableStateOf(Tab.Sports) }
    val slipState by deps.betSlip.state.collectAsStateWithLifecycle()
    val slipCount = slipState.selections.size

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bg)
            .statusBarsPadding(),
    ) {
        TopHeader(label = stringResource(selected.labelRes), slipCount = slipCount, onSlipTap = onOpenSlip)
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (selected) {
                Tab.Sports -> SportsListScreen(onSportClicked = onNavigateSport)
                Tab.Community -> CommunityFeedScreen(
                    onProfileTap = onNavigateProfile,
                    onSlipUpdated = onOpenSlip,
                )
                Tab.Bets -> BetsScreen()
                Tab.Wallet -> WalletScreen()
                Tab.Account -> AccountScreen()
            }
        }
        BottomBar(selected = selected, onSelect = { selected = it })
    }
}

@Composable
private fun TopHeader(label: String, slipCount: Int, onSlipTap: () -> Unit) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Oddzilla", style = MaterialTheme.typography.titleLarge, color = colors.fg)
        Box(modifier = Modifier.weight(1f))
        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
        if (slipCount > 0) {
            Box(modifier = Modifier.padding(start = 12.dp)) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(percent = 50))
                        .background(colors.accent)
                        .clickable(onClickLabel = "Open bet slip", onClick = onSlipTap)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(
                        "Slip · $slipCount",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.accentFg,
                    )
                }
            }
        }
    }
}

@Composable
private fun BottomBar(selected: Tab, onSelect: (Tab) -> Unit) {
    val colors = OzTheme.colors
    val items = remember { Tab.entries.toList() }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(64.dp)
            .background(colors.bgElevated),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { tab ->
            val active = tab == selected
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clickable(onClickLabel = "Switch to ${tab.name}") { onSelect(tab) }
                    .padding(vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    imageVector = tab.icon,
                    contentDescription = stringResource(tab.labelRes),
                    tint = if (active) colors.fg else colors.fgDim,
                )
                Text(
                    stringResource(tab.labelRes),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (active) colors.fg else colors.fgDim,
                )
            }
        }
    }
}
