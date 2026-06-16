import SwiftUI

// A slash command that spawns sessions — the sidebar's top-level grouping axis.
struct SlashCommand: Identifiable, Hashable {
    let name: String       // "/diagnose"
    let symbol: String     // SF Symbol
    var id: String { name }
}

extension SlashCommand {
    static let diagnose = SlashCommand(name: "/diagnose", symbol: "stethoscope")
    static let review   = SlashCommand(name: "/review", symbol: "checklist")
    static let mint     = SlashCommand(name: "/mint", symbol: "hammer.fill")
    static let refactor = SlashCommand(name: "/refactor", symbol: "arrow.triangle.2.circlepath")
    static let ship     = SlashCommand(name: "/ship", symbol: "paperplane.fill")

    /// Catalog surfaced in the "new session" command palette.
    static let all: [SlashCommand] = [
        .diagnose, .review, .mint, .refactor, .ship,
        SlashCommand(name: "/onboard", symbol: "map.fill"),
        SlashCommand(name: "/simplify", symbol: "scissors"),
        SlashCommand(name: "/heal", symbol: "bandage.fill"),
        SlashCommand(name: "/gather", symbol: "tray.full.fill")
    ]
}

// Mirrors AFK's session lifecycle + terminal states (src/agent/routing-directive.ts,
// terminal-state.ts:44, session-types.ts). "running" folds processing+streaming.
enum SessionStatus: String, CaseIterable, Hashable {
    case running, compacting, done, blocked, asking, interrupted

    var label: String {
        switch self {
        case .running: "running"
        case .compacting: "compacting"
        case .done: "done"
        case .blocked: "blocked"
        case .asking: "asking"
        case .interrupted: "interrupted"
        }
    }
    // Status is encoded as color + SHAPE (never color alone) — accessibility.
    var symbol: String {
        switch self {
        case .running: "circle.dotted"
        case .compacting: "arrow.triangle.2.circlepath"
        case .done: "checkmark.circle.fill"
        case .blocked: "exclamationmark.octagon.fill"
        case .asking: "questionmark.circle.fill"
        case .interrupted: "pause.circle.fill"
        }
    }
    var color: Color {
        switch self {
        case .running: Theme.accent
        case .compacting: Theme.muted
        case .done: Theme.success
        case .blocked: Theme.danger
        case .asking: Theme.amber
        case .interrupted: Theme.faint
        }
    }
    var needsYou: Bool { self == .asking || self == .blocked }
    var isLive: Bool { self == .running || self == .compacting }
}

// Runtime surface (src/agent/awareness/types.ts:36).
enum Surface: String {
    case cli, repl, daemon, telegram, subagent
    var symbol: String {
        switch self {
        case .cli, .repl: "terminal.fill"
        case .daemon: "moon.fill"
        case .telegram: "paperplane.fill"
        case .subagent: "arrow.triangle.branch"
        }
    }
}

struct Session: Identifiable {
    let id: String           // real-ish session id (persisted under ~/.afk/state/sessions/<id>)
    let command: SlashCommand
    var title: String
    var status: SessionStatus
    var model: String
    var surface: Surface
    var elapsed: String
    var turns: Int
    var tokens: Int
    var tokenSeries: [Double]
    var messages: [Message]
    var pendingElicitation: Elicitation?
}

enum SessionFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case running = "Running"
    case needsYou = "Needs you"
    var id: String { rawValue }
}
