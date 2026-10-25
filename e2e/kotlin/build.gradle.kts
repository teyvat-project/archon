// End-to-end tests of the generated Kotlin SDK against e2e/mock-server; run with `pnpm test:e2e:kotlin`.
plugins {
    kotlin("jvm") version "2.4.21"
}

dependencies {
    testImplementation("archon.e2e:edge-cases")
    testImplementation("io.ktor:ktor-client-cio:3.6.0")
    testImplementation(platform("org.junit:junit-bom:5.14.4"))
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.junit.jupiter:junit-jupiter-params")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    compilerOptions {
        allWarningsAsErrors.set(true)
    }
}

tasks.test {
    useJUnitPlatform()
    // The tests talk to a mock server started per run; never skip them as up to date.
    outputs.upToDateWhen { false }
    systemProperty("archon.e2e.baseUrl", providers.gradleProperty("archon.e2e.baseUrl").getOrElse(""))
    systemProperty("archon.e2e.secondaryUrl", providers.gradleProperty("archon.e2e.secondaryUrl").getOrElse(""))
    // Ktor logs through SLF4J; without a provider on the test classpath it warns on every run.
    systemProperty("slf4j.internal.verbosity", "ERROR")
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
