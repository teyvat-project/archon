import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Development project for the hand-written runtime. The generator copies src/main/kotlin into the generated SDK
// (the package is rewritten); this build file is not copied.
plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.serialization") version "2.4.21"
    `java-library`
}

repositories {
    mavenCentral()
}

dependencies {
    api("io.ktor:ktor-client-core:3.6.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")

    testImplementation(platform("org.junit:junit-bom:5.14.4"))
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.junit.jupiter:junit-jupiter-params")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("io.ktor:ktor-client-mock:3.6.0")
    testImplementation("io.ktor:ktor-client-cio:3.6.0")
    testImplementation("io.ktor:ktor-client-okhttp:3.6.0")
    testImplementation("io.ktor:ktor-client-android:3.6.0")
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
    explicitApi()
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
        allWarningsAsErrors.set(true)
        freeCompilerArgs.add("-Xjdk-release=11")
    }
}

tasks.test {
    useJUnitPlatform()
    // Ktor logs through SLF4J; without a provider on the test classpath it warns on every run.
    systemProperty("slf4j.internal.verbosity", "ERROR")
}
