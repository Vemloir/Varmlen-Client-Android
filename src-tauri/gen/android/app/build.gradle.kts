import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing: loaded from a key.properties file OUTSIDE this repo (never
// commit a keystore or its passwords). Path comes from the
// VARMLEN_KEYSTORE_PROPERTIES env var; if unset or the file is missing,
// release builds fall back to Android's default debug signing so the build
// still works for anyone without the release key.
val releaseSigningProps = Properties().apply {
    val path = System.getenv("VARMLEN_KEYSTORE_PROPERTIES")
    if (path != null && file(path).exists()) {
        file(path).inputStream().use { load(it) }
    }
}
fun passwordFromFile(environmentName: String): String? {
    val path = System.getenv(environmentName) ?: return null
    val passwordFile = file(path)
    return if (passwordFile.isFile) {
        passwordFile.readText().trimEnd('\r', '\n')
    } else {
        null
    }
}

val releaseStoreFile =
    releaseSigningProps.getProperty("storeFile") ?: System.getenv("VARMLEN_KEYSTORE_FILE")
val releaseStorePassword =
    releaseSigningProps.getProperty("storePassword")
        ?: passwordFromFile("VARMLEN_KEYSTORE_PASSWORD_FILE")
val releaseKeyAlias =
    releaseSigningProps.getProperty("keyAlias")
        ?: System.getenv("VARMLEN_KEY_ALIAS")
        ?: "varmlen"
val releaseKeyPassword =
    releaseSigningProps.getProperty("keyPassword") ?: releaseStorePassword
val hasReleaseSigning =
    releaseStoreFile != null && releaseStorePassword != null && releaseKeyPassword != null

android {
    compileSdk = 36
    namespace = "app.varmlen.client"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.varmlen.client"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // We ship arm64 native libs (xray + tun2socks); build the JNI shim for it.
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    // Extract native libs to disk so the bundled xray binary (libxray.so) can be
    // exec'd from nativeLibraryDir.
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
