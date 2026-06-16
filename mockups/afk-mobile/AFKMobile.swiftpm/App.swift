import SwiftUI

// @main entry. Dark-mode-first; warm-orange brand tint applied app-wide.
@main
struct AFKMobileApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
