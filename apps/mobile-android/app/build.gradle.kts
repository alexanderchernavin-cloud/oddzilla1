import java.util.Properties

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinAndroid)
    alias(libs.plugins.kotlinCompose)
    alias(libs.plugins.kotlinSerialization)
}

// FCM activation gate. The Google Services Gradle plugin parses
// google-services.json and generates the string resources Firebase's
// auto-init reads at runtime. The plugin fails the build when the
// JSON is missing, so we only apply it when the file is present —
// fresh checkouts (no Firebase project yet) still build cleanly; a
// drop-in of google-services.json at apps/mobile-android/app/
// (gitignored per the root .gitignore) flips real FCM dispatch on
// without any further code edits. Runtime branches in
// cc.oddzilla.app.fcm.PushBootstrap gate on BuildConfig.FIREBASE_ENABLED.
val googleServicesJson = file("google-services.json")
val firebaseEnabled = googleServicesJson.exists()
if (firebaseEnabled) {
    apply(plugin = "com.google.gms.google-services")
}

// --- Version stamping ----------------------------------------------------
// Source of truth lives in ../version.properties so the release script
// can bump it without touching gradle files.
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val appVersionCode = (versionProps["versionCode"] as String).toInt()
val appVersionName = versionProps["versionName"] as String

// --- Signing -------------------------------------------------------------
// keystore.properties is gitignored; lives next to local.properties.
// If it doesn't exist (e.g. first checkout), release builds fall back
// to the debug keystore so the project still compiles.
val keystoreFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) }
}

android {
    namespace = "cc.oddzilla.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "cc.oddzilla.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        // BuildConfig values consumed by the API client + UpdateChecker.
        // ApiBaseUrl: Caddy in front of the api at https://oddzilla.cc/api.
        // WsUrl: Caddy proxies /ws to ws-gateway.
        // VersionManifestUrl: Caddy serves /srv/oddzilla-apk/version.json.
        // OriginHeader: matches CORS_ORIGINS so CSRF plugin lets us through.
        buildConfigField("String", "API_BASE_URL", "\"https://oddzilla.cc/api/\"")
        buildConfigField("String", "WS_URL", "\"wss://oddzilla.cc/ws\"")
        buildConfigField("String", "VERSION_MANIFEST_URL", "\"https://oddzilla.cc/app/version.json\"")
        buildConfigField("String", "ORIGIN_HEADER", "\"https://oddzilla.cc\"")
        // Set at configuration time from the google-services.json
        // presence check above. Read at runtime by PushBootstrap to
        // skip every Firebase call cleanly when the SDK wasn't
        // initialized — calling FirebaseMessaging.getInstance() without
        // initialization throws IllegalStateException.
        buildConfigField("boolean", "FIREBASE_ENABLED", "$firebaseEnabled")
    }

    signingConfigs {
        create("release") {
            if (keystoreFile.exists()) {
                storeFile = file(keystoreProps["storeFile"] as String)
                storePassword = keystoreProps["storePassword"] as String
                keyAlias = keystoreProps["keyAlias"] as String
                keyPassword = keystoreProps["keyPassword"] as String
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isDebuggable = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = if (keystoreFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                // Fall back to debug signing for unconfigured checkouts so
                // assembleRelease still produces an APK. Distributing it
                // would fail the install-time signature check on top of
                // an existing release build, so the release script
                // refuses to ship if keystore.properties is missing.
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/DEPENDENCIES",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
            )
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.splashscreen)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    // Firebase Cloud Messaging. Pulled in unconditionally so the
    // dependency graph is stable; the Google Services Gradle plugin
    // (applied above only when google-services.json is present)
    // generates the resources the SDK reads at runtime auto-init.
    // Without the JSON the FirebaseInitProvider silently no-ops and
    // PushBootstrap takes the BuildConfig.FIREBASE_ENABLED=false path.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging.ktx)

    implementation(libs.coil.compose)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
}
