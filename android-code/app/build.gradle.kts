import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Push through Firebase Cloud Messaging is off until the owner's Firebase project exists: put its
// values in firebase.properties next to settings.gradle.kts (git-ignored; see ../README.md). Without
// them the app never starts Firebase and relies on its live connection to the Mac while it runs.
val firebase = Properties().apply {
    val f = rootProject.file("firebase.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun fb(key: String) = "\"" + (firebase.getProperty(key) ?: "").replace("\"", "") + "\""

android {
    namespace = "com.askeden.edencode"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.askeden.edencode"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "FCM_PROJECT_ID", fb("projectId"))
        buildConfigField("String", "FCM_APP_ID", fb("appId"))
        buildConfigField("String", "FCM_API_KEY", fb("apiKey"))
        buildConfigField("String", "FCM_SENDER_ID", fb("senderId"))
    }

    buildTypes {
        release {
            // No signing config here on purpose: release signing and Play uploads are the owner's.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // The Mac's pinned TLS, straight or inside the relay's WebSocket.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // A risky yes asks for the owner's fingerprint or face first (Face ID on the iPhone).
    implementation("androidx.biometric:biometric:1.1.0")
    // Pushes, once firebase.properties exists (initialised by hand: no google-services plugin).
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}
