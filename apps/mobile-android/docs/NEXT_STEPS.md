# Android app — next steps

Snapshot of what's done, what's blocking the **first public release-signed APK**,
and the priority-ordered backlog for everything beyond.

## Status as of v0.4.0

A debug-signed APK builds locally and on GitHub Actions. The full storefront
flow works against the live `oddzilla.cc` API: signup / login, browse sports
→ matches → markets, place single + combo bets in USDC or OZ, watch odds tick
in real time, cash out an active ticket, view balances + submit deposit-intent
+ withdrawal-request, browse the community feed and copy a winning bet into
your slip. The in-app update modal polls `/app/version.json` and offers the
new APK on launch.

Server-side push **registration** is live (`/devices/register` + `user_devices`
table). Server-side push **sending** is not yet wired — that's the FCM /
Firebase Admin SDK piece below.

## Critical path to a release-signed APK published at oddzilla.cc/app

These are the only steps blocking real users from installing v0.4.0 via the
in-app update flow once a future release ships.

1. **Generate the release keystore.** One-time, kept off the repo:
   ```powershell
   keytool -genkeypair -v `
     -keystore "$env:USERPROFILE\keys\oddzilla.jks" `
     -alias oddzilla `
     -keyalg RSA -keysize 4096 -validity 25000 `
     -dname "CN=Oddzilla, O=Oddzilla, C=NL"
   ```
   Back up the `.jks` somewhere durable. Losing it means no future build can
   upgrade an installed copy (Android rejects signature changes).

2. **Configure local signing** so `release.ps1` can produce a signed APK.
   Copy `keystore.properties.example` → `keystore.properties`, fill in the
   four values pointing at the keystore from step 1.

3. **Bootstrap the APK directory on the box** (one-time):
   ```bash
   ssh team@178.104.174.24 'sudo bash /home/team/oddzilla/infra/hetzner/oddzilla-apk-init.sh'
   ssh team@178.104.174.24 'cd /home/team/oddzilla && sudo -n docker compose up -d --no-deps caddy'
   ```
   The first command creates `/srv/oddzilla-apk/` with a placeholder
   `version.json` (versionCode=0); the second restarts Caddy so the new
   `/app/*` route activates.

4. **Run the local release pipeline**:
   ```powershell
   cd apps/mobile-android
   .\scripts\release.ps1 -ReleaseNotes "Initial 0.4.0 release"
   ```
   This bumps nothing automatically — `version.properties` is already at
   `0.4.0` (versionCode 4). The script builds, hashes, scps the APK, and
   atomically swaps the `version.json`. Browser visit
   `https://oddzilla.cc/app/version.json` to verify.

5. **(Alternative) Use the GitHub Actions release pipeline.** Set the secrets
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
   `ANDROID_KEY_PASSWORD`, `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` in the
   repo settings, then **Actions → android → Run workflow → release: true →
   release_notes: "..."**. CI signs and ships in ~5 min. This is the
   path you'll want long-term so releases don't depend on whichever laptop
   has the keystore.

6. **Sideload the first install onto a phone manually.** Email the APK to
   yourself, tap → install. From v0.4.1+ the in-app update modal handles
   subsequent versions automatically — the user taps **Update**, the APK
   downloads + verifies SHA-256 + the system installer fires.

## Next features (priority order)

### 1. Real launcher icon (Small — 30 min)
Current `ic_launcher_foreground.xml` is a placeholder serif "O". Drop a real
brand mark into `app/src/main/res/mipmap-anydpi-v26/` as an adaptive icon, or
use Android Studio's **Image Asset Studio** (right-click `app` → New → Image
Asset → Launcher Icon (Adaptive)).

### 2. Real fonts (Small — 15 min)
Geist + Instrument Serif TTFs go into `app/src/main/res/font/`. Then swap
two `FontFamily` references in `ui/theme/Type.kt` per the walkthrough at
[`docs/fonts.md`](./fonts.md). Layout metrics already match the system
fallbacks, so this is purely a visual fidelity bump.

### 3. FCM client-side wiring (Medium — 2-3 hours)
Server-side intake is live; client side is intentionally not built so the
build doesn't depend on a `google-services.json` you don't have yet.

1. Create a Firebase project at https://console.firebase.google.com
2. Add an Android app for `cc.oddzilla.app` (and optionally `.debug` for a
   separate debug Firebase project)
3. Download `google-services.json` → `app/google-services.json`
   (gitignored already)
4. Follow the 5-step walkthrough at
   [`apps/mobile-android/app/src/main/java/cc/oddzilla/app/fcm/README.md`](../app/src/main/java/cc/oddzilla/app/fcm/README.md):
   - Add the google-services Gradle plugin
   - Add Firebase BOM + firebase-messaging-ktx deps
   - Rename `FcmService.kt.example` → `FcmService.kt`
   - Wire `FirebaseMessaging.getInstance().token` registration after login
   - Wire `POST_NOTIFICATIONS` runtime permission flow

### 4. Server-side push sender (Medium — 3-4 hours)
The send half. Concrete checklist:

1. Generate a Firebase Admin service account JSON in the Firebase console
   (Project settings → Service accounts → Generate new private key)
2. `scp` it to `/srv/oddzilla-firebase/service-account.json` on the box
   (mode 600, owned by the api UID)
3. Mount it into the api container in `docker-compose.yml`:
   ```yaml
   api:
     volumes:
       - /srv/oddzilla-firebase/service-account.json:/run/firebase/service-account.json:ro
     environment:
       GOOGLE_APPLICATION_CREDENTIALS: /run/firebase/service-account.json
   ```
4. `pnpm --filter @oddzilla/api add firebase-admin`
5. Write `services/api/src/lib/push.ts` — wraps
   `admin.messaging().sendEachForMulticast()` against `user_devices` rows for
   the recipient
6. Decide which events trigger pushes. PRD-aligned starting set:
   - Bet settled (always — sportsbook owns this channel)
   - Cashout offer crossed a threshold (probably opt-in; needs preferences UI)
   - Bet inspired by your community ticket (gated on `bet_inspired`
     preference from migration `0044_community_notifications`)
7. Call the wrapper from `services/settlement` (Go — needs an HTTP call into
   the api or a shared Firebase Admin client in Go), and from
   `services/api/src/modules/cashout/service.ts` on quote-acceptance
8. Add a "Notification preferences" UI on the mobile Account tab (mirrors
   what the web has under `/account/notifications`)

### 5. Smoke testing on a real device (Small — 1 hour, but blocking)
The whole flow has only been validated by `gradlew assembleDebug` building.
Walk through every screen on a real Android phone with the prod backend:
- Sign up + login (verify the cookies persist across kill+relaunch)
- Browse sports → tap CS2 → tap a live match → see odds tick in real time
- Pick an outcome → bet slip peek shows → tap → adjust stake → place
- Confirm the ticket appears under Bets → Active
- Watch a settle event come through (or wait for one), confirm Bets refreshes
- Cash out an open ticket end-to-end
- Wallet: copy address, link a sending wallet, submit a withdrawal request
- Community: scroll feed, tap a profile, copy a settled bet into the slip
- Trigger an update by manually editing version.json on the server to a
  higher versionCode → confirm the in-app modal fires

Anything that breaks here gets a follow-up issue. Likely candidates: the
WebView stream embed (Twitch / YouTube parent permissions), the ModalBottomSheet
on small screens (300dp wide phones), pull-to-refresh feel.

### 6. Bet slip drift accept polish (Small — 1 hour)
The drift accept flow lands in v0.4.0 but per-leg accept-individual-changes
is not yet possible — it's all-or-nothing via `acceptPendingOdds()`. If a
single leg moves, the user has to accept the whole batch. Web has the same
limitation; not blocking but worth a UX iteration.

### 7. Analyses (Phase 10.5) + Competitions (Phase 11) (Large — multi-day each)
Both surfaces exist on the web (see migration `0042_community_analyses` and
`0043_community_competitions`) and have full DTOs in
[`packages/types/src/community.ts`](../../../packages/types/src/community.ts).
For mobile each is roughly:
- New screen (analysis editor / competition lobby)
- New nav route under the Community tab
- New repo + endpoints in OddzillaApi
- For competitions specifically: prediction submission UI + leaderboard
  rendering
Defer until smoke-testing and FCM are green.

### 8. Notifications panel (Phase 12) (Medium — 1-2 days)
The bell-icon panel from the web lives at `/community/notifications`. Mobile
needs:
- A bell icon in the top bar
- A pull-down or full-screen panel showing `user_notifications` rows
- Per-row deep links into the Bets / Community / Match pages
- `mark-read` integration

### 9. Pre-launch hardening (Medium — 2-3 hours, blocking real users)
- ProGuard/R8 rules audit — current rules cover Compose, Retrofit, OkHttp,
  kotlinx.serialization. Run an actual release build with `assembleRelease`
  + install on a phone, click through every screen, watch logcat for
  `NoSuchMethodError` / `ClassNotFoundException`. Add keep rules as needed.
- Make sure `BuildConfig.API_BASE_URL` doesn't leak debug fallbacks — verify
  release build hits prod oddzilla.cc.
- Strip `BuildConfig.DEBUG` log lines that contain user data — none today
  AFAIK but worth a grep before going public.

## Deferred / not-doing-soon

- **iOS app** — would mean an `apps/mobile-ios/` sibling. Most of the
  storefront patterns here translate (cookie-based auth, REST + WS, design
  tokens) but the toolchain is fully different (Xcode, Swift, no Compose).
  Decide based on user demand.
- **PlayStore release** — the original requirement was self-distributed
  APK. PlayStore has explicit gambling-app rules that vary by region; if
  you ever want it, it'll need a separate compliance pass.
- **Real-time live odds via direct AMQP** — currently we hop
  `Oddin AMQP → feed-ingester → Redis pub/sub → ws-gateway → mobile WS`.
  Direct mobile-to-AMQP is feasible but exposes the bookmaker token, so
  forget it.

## Build pipeline reference

- **Local debug build**: from `apps/mobile-android/`:
  ```powershell
  .\gradlew.bat :app:assembleDebug
  ```
  APK at `app/build/outputs/apk/debug/app-debug.apk`.

- **Local release build**: requires `keystore.properties`. Use the release
  script:
  ```powershell
  .\scripts\release.ps1 -ReleaseNotes "0.4.1 fixes"
  ```

- **CI debug build**: push a change under `apps/mobile-android/**` to main.
  GH Actions builds the debug APK and uploads as a workflow artifact under
  `oddzilla-<version>-debug`.

- **CI release build**: GitHub → Actions → android → Run workflow →
  `release: true`. Requires the secrets listed in the workflow file.

## Common pitfalls (caught during v0.4.0 build)

1. **Don't put non-resource files inside `res/`.** Android's resource merger
   only accepts the documented file types per directory. Docs go in
   `apps/mobile-android/docs/`.

2. **Don't use Material 3's deprecated DayNight parent.** `Theme.Material3.DayNight.NoActionBar`
   doesn't exist. The current activity theme is `android:Theme.Material.Light.NoActionBar`
   (framework theme, no extra deps); Compose's `OddzillaTheme` does the
   actual theming.

3. **Don't pin a third-party Retrofit converter.** The Jake Wharton
   kotlinx-serialization converter is at v1.0.0 against Retrofit 2.9 — it
   doesn't compile against 2.11. Use Square's first-party
   `com.squareup.retrofit2:converter-kotlinx-serialization`, version-pinned
   to the Retrofit version.

4. **`remember { }` only inside @Composable functions.** Lambdas inside a
   `LazyColumn { }` are `LazyListScope.() -> Unit`, not `@Composable`. Hoist
   any memoization out to the parent composable scope. (Inside an
   `item { }` or `items { }` block IS @Composable; outside isn't.)

5. **PowerShell pipes don't propagate stdin reliably to native commands.**
   `"y\n" | sdkmanager --licenses` hangs forever. Use
   `cmd /c "type yes.txt | sdkmanager --licenses"` instead.
