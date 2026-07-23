import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val localProps = Properties().apply {
  val f = rootProject.file("local.properties")
  if (f.exists()) {
    f.inputStream().use { load(it) }
  }
}

fun prop(name: String): String {
  val a = localProps.getProperty(name)?.trim().orEmpty()
  if (a.isNotEmpty()) return a
  val b = System.getenv(name)?.trim().orEmpty()
  if (b.isNotEmpty()) return b
  return ""
}

android {
  namespace = "ai.faulttree.app"
  compileSdk = 34

  defaultConfig {
    applicationId = "ai.faulttree.app"
    minSdk = 24
    targetSdk = 34
    versionCode = 1
    versionName = "1.0.0"

    ndk {
      abiFilters += listOf("armeabi-v7a", "arm64-v8a")
    }

    buildConfigField("String", "SERVER_URL", "\"${prop("SERVER_URL")}\"")
  }

  buildFeatures {
    buildConfig = true
  }

  signingConfigs {
    create("release") {
      val storeFilePath = prop("RELEASE_STORE_FILE")
      val storePassword = prop("RELEASE_STORE_PASSWORD")
      val keyAlias = prop("RELEASE_KEY_ALIAS")
      val keyPassword = prop("RELEASE_KEY_PASSWORD")

      if (storeFilePath.isNotEmpty() && storePassword.isNotEmpty() && keyAlias.isNotEmpty() && keyPassword.isNotEmpty()) {
        storeFile = file(storeFilePath)
        this.storePassword = storePassword
        this.keyAlias = keyAlias
        this.keyPassword = keyPassword
      } else {
        storeFile = file("${System.getProperty("user.home")}/.android/debug.keystore")
        this.storePassword = "android"
        this.keyAlias = "androiddebugkey"
        this.keyPassword = "android"
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.constraintlayout:constraintlayout:2.1.4")
  implementation("androidx.recyclerview:recyclerview:1.3.2")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.google.code.gson:gson:2.11.0")

  // BytePlus RTC Android SDK
  implementation("com.byteplus:BytePlusRTC:3.60.104.1300")
}
