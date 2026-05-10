package cc.oddzilla.app.common

import androidx.compose.runtime.staticCompositionLocalOf
import cc.oddzilla.app.bet.BetSlipController
import cc.oddzilla.app.data.repo.AuthRepository
import cc.oddzilla.app.data.repo.BetsRepository
import cc.oddzilla.app.data.repo.CatalogRepository
import cc.oddzilla.app.data.repo.CommunityRepository
import cc.oddzilla.app.data.repo.DevicesRepository
import cc.oddzilla.app.data.repo.WalletRepository
import cc.oddzilla.app.data.ws.LiveOddsClient
import cc.oddzilla.app.update.UpdateController

// Service-locator container exposed via CompositionLocal. Every screen
// reads `LocalDeps.current` and pulls whichever repo / controller it
// needs; ViewModels take the same container in their constructor.
//
// Heavier projects would use a DI framework (Hilt, Koin) — for this
// app's surface area a plain locator is clearer and ships less build
// machinery.

class OddzillaDeps(
    val authRepository: AuthRepository,
    val catalogRepository: CatalogRepository,
    val betsRepository: BetsRepository,
    val walletRepository: WalletRepository,
    val communityRepository: CommunityRepository,
    val devicesRepository: DevicesRepository,
    val liveOdds: LiveOddsClient,
    val betSlip: BetSlipController,
    val updateController: UpdateController,
    val snackbar: SnackbarController,
)

val LocalDeps = staticCompositionLocalOf<OddzillaDeps> {
    error("LocalDeps not provided — wrap content in OddzillaApp.deps Provider")
}
