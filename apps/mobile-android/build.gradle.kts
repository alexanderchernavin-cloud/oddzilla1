plugins {
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.kotlinAndroid) apply false
    alias(libs.plugins.kotlinCompose) apply false
    alias(libs.plugins.kotlinSerialization) apply false
    // FCM. The plugin is only applied in :app when google-services.json
    // is present (see app/build.gradle.kts) — keeps the project buildable
    // for fresh checkouts that haven't set up a Firebase project yet.
    alias(libs.plugins.googleServices) apply false
}
