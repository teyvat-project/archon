// swift-tools-version:6.0
// The runtime that generated Swift SDKs vendor as their `<Module>Core` target (src/ is copied as-is).
import PackageDescription

let package = Package(
    name: "ArchonRuntime",
    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8), .visionOS(.v1)],
    products: [.library(name: "ArchonRuntime", targets: ["ArchonRuntime"])],
    targets: [
        .target(name: "ArchonRuntime", path: "src"),
        .testTarget(name: "ArchonRuntimeTests", dependencies: ["ArchonRuntime"], path: "tests"),
    ]
)
