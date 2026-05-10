package cc.oddzilla.app

import android.app.Application
import cc.oddzilla.app.bet.BetSlipController
import cc.oddzilla.app.common.OddzillaDeps
import cc.oddzilla.app.common.SnackbarController
import cc.oddzilla.app.data.api.HttpClientFactory
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.repo.AuthRepository
import cc.oddzilla.app.data.repo.BetsRepository
import cc.oddzilla.app.data.repo.CatalogRepository
import cc.oddzilla.app.data.repo.CommunityRepository
import cc.oddzilla.app.data.repo.DevicesRepository
import cc.oddzilla.app.data.repo.WalletRepository
import cc.oddzilla.app.data.ws.LiveOddsClient
import cc.oddzilla.app.update.UpdateController

// Application class doubles as the manual-DI graph root. Constructed
// once on process start; deps are exposed via `OddzillaDeps` and
// surfaced to Composables through the LocalDeps CompositionLocal in
// MainActivity.

class OddzillaApp : Application() {

    lateinit var deps: OddzillaDeps
        private set

    override fun onCreate() {
        super.onCreate()

        val cookieJar = PersistentCookieJar(this)
        val (httpClient, retrofit) = HttpClientFactory.build(
            cookieJar = cookieJar,
            versionName = BuildConfig.VERSION_NAME,
        )
        val api: OddzillaApi = retrofit.create(OddzillaApi::class.java)

        val authRepository = AuthRepository(api = api, cookieJar = cookieJar)
        val catalogRepository = CatalogRepository(api = api)
        val betsRepository = BetsRepository(api = api)
        val walletRepository = WalletRepository(api = api)
        val communityRepository = CommunityRepository(api = api)
        val devicesRepository = DevicesRepository(api = api)
        val liveOdds = LiveOddsClient(client = httpClient)
        val betSlip = BetSlipController(context = this, betsRepo = betsRepository, liveOdds = liveOdds)
        val updateController = UpdateController(context = this, httpClient = httpClient)
        val snackbar = SnackbarController()

        deps = OddzillaDeps(
            authRepository = authRepository,
            catalogRepository = catalogRepository,
            betsRepository = betsRepository,
            walletRepository = walletRepository,
            communityRepository = communityRepository,
            devicesRepository = devicesRepository,
            liveOdds = liveOdds,
            betSlip = betSlip,
            updateController = updateController,
            snackbar = snackbar,
        )
    }
}
