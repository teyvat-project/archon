// Turns every Kotlin compiler warning into an error for the generated SDK builds in kotlin-compile.test.ts.
// Init scripts do not see the Kotlin Gradle plugin's classes, so the option is set through reflection.
allprojects {
    tasks.matching { it.javaClass.name.startsWith("org.jetbrains.kotlin.gradle.tasks.KotlinCompile") }.configureEach {
        val options = javaClass.getMethod("getCompilerOptions").invoke(this)
        val property = options.javaClass.getMethod("getAllWarningsAsErrors").invoke(options)
        property.javaClass.getMethod("set", Any::class.java).invoke(property, true)
    }
}
