import SwiftUI

// NavigationSplitView: floating glass sidebar on iPad, auto-collapses to a
// push-navigation stack on iPhone. One API, adaptive across size classes.
struct RootView: View {
    @State private var model = AppModel.demo()
    @State private var columnVisibility: NavigationSplitViewVisibility =
        ProcessInfo.processInfo.environment["AFK_COLS"] == "all" ? .all : .automatic
    // On iPhone (compact), deep-link straight to a session's detail when requested
    // (AFK_COMPACT=detail); otherwise open on the sidebar — the correct default.
    @State private var compactColumn: NavigationSplitViewColumn =
        ProcessInfo.processInfo.environment["AFK_COMPACT"] == "detail" ? .detail : .sidebar

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
            SidebarView(model: model)
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
        } detail: {
            if model.selectedSession != nil {
                SessionDetailView(model: model)
            } else {
                ContentUnavailableView(
                    "Select a session",
                    systemImage: "sidebar.left",
                    description: Text("Pick a session from the sidebar to view its transcript.")
                )
                .background(Theme.bg)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .tint(Theme.accent)
    }
}

#Preview("Root") {
    RootView().preferredColorScheme(.dark)
}
