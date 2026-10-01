plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.google.services)
}

val serverUrl = (findProperty("companionServerUrl") as String?)?.trimEnd('/')
    ?: error("companionServerUrl is not set in gradle.properties")
require(serverUrl.startsWith("https://")) { "companionServerUrl must be https" }

android {
    namespace = "com.tzur.callcompanion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tzur.callcompanion"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "0.7.0"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // The only dependency: FCM, to be woken for a message or a call request
    // (PLAN §6.17, §6.18). Everything else — HTTP, JSON, SQLite, the Keystore,
    // the recorder — is the platform's own.
    implementation(libs.firebase.messaging)
    testImplementation(libs.junit)
}
