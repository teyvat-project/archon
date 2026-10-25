// swift-tools-version:6.0
// End-to-end tests of the Swift SDK generated from fixtures/specs/edge-cases.yaml (run with `pnpm test:e2e:swift`).
import PackageDescription

let package = Package(
    name: "ArchonE2ESwift",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "generated/EdgeCases")],
    targets: [
        .testTarget(
            name: "ArchonE2ETests",
            dependencies: [.product(name: "ArchonEdgeCases", package: "EdgeCases")],
            path: "Tests/ArchonE2ETests"
        ),
    ]
)
