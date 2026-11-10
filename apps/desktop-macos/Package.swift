// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "BladeNotes",
    platforms: [.macOS("14.0")],
    targets: [.executableTarget(name: "BladeNotes", path: "Sources")]
)
