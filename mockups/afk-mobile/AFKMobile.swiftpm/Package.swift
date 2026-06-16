// swift-tools-version: 5.9
// AFK Mobile — agent mission control mockup.
// Open in Xcode 26+ or Swift Playgrounds and run on an iPhone/iPad simulator or device.
import PackageDescription
import AppleProductTypes

let package = Package(
    name: "AFKMobile",
    platforms: [
        .iOS("26.0")
    ],
    products: [
        .iOSApplication(
            name: "AFKMobile",
            targets: ["AppModule"],
            bundleIdentifier: "com.afk.mobile.AFKMobile",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
