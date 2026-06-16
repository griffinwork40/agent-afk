import SwiftUI

// One transcript item. `kind` maps to AFK's real MessageChunk/OutputEvent kinds
// (src/agent/session/stream-consumer.ts, session-types.ts:83).
struct Message: Identifiable {
    let id = UUID()
    var kind: MessageKind
}

enum MessageKind {
    case user(String)
    case agentText(String)        // markdown
    case agentStreaming(String)   // revealed progressively (live token stream)
    case thinking(String)         // reasoning delta
    case toolCall(ToolCall)       // tool_use_detail + tool_result
    case toolDiff(FileDiff)       // tool_diff sidecar
    case subagents([SubagentRef]) // SubagentManager fan-out
    case compose([ComposeNode])   // compose/DAG (dag.ts:50)
    case panel(Panel)             // skill-emitted panel (PanelSpec)
    case paused(resetsAt: String, autoResume: Bool)  // usage-limit pause
    case terminal(TerminalState)  // end-of-turn terminal state
}

enum ToolStatus {
    case running, ok, error
    var symbol: String {
        switch self {
        case .running: "circle.dotted"
        case .ok: "checkmark"
        case .error: "xmark"
        }
    }
    var color: Color {
        switch self {
        case .running: Theme.accent
        case .ok: Theme.success
        case .error: Theme.danger
        }
    }
}

struct ToolCall: Identifiable {
    let id = UUID()
    let name: String       // "bash", "edit_file", "grep"…
    let arg: String        // short summary
    let input: String      // full input (mono)
    let output: String
    var status: ToolStatus
    var truncated: Bool = false
    var durationMs: Int = 0

    var symbol: String {
        switch name {
        case "bash": "terminal"
        case "edit_file", "write_file": "pencil"
        case "read_file": "doc.text"
        case "grep": "magnifyingglass"
        case "glob": "folder"
        default: "wrench.and.screwdriver"
        }
    }
}

enum DiffKind {
    case add, remove, context
    var color: Color {
        switch self {
        case .add: Theme.success
        case .remove: Theme.danger
        case .context: Theme.faint
        }
    }
    var sign: String {
        switch self {
        case .add: "+"
        case .remove: "-"
        case .context: " "
        }
    }
}

struct DiffLine: Identifiable {
    let id = UUID()
    let kind: DiffKind
    let oldNum: Int?
    let newNum: Int?
    let text: String
}

struct FileDiff: Identifiable {
    let id = UUID()
    let path: String
    let lines: [DiffLine]
    var added: Int { lines.filter { $0.kind == .add }.count }
    var removed: Int { lines.filter { $0.kind == .remove }.count }
}

// SubagentResult (src/agent/subagent/result.ts:61).
enum SubStatus {
    case idle, running, succeeded, failed, cancelled
    var symbol: String {
        switch self {
        case .idle: "circle"
        case .running: "circle.dotted"
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .cancelled: "minus.circle.fill"
        }
    }
    var color: Color {
        switch self {
        case .idle: Theme.faint
        case .running: Theme.accent
        case .succeeded: Theme.success
        case .failed: Theme.danger
        case .cancelled: Theme.faint
        }
    }
}

struct SubagentRef: Identifiable {
    let id = UUID()
    let label: String
    var status: SubStatus
    var completion: Double   // 0...1
    let turns: Int
    let summary: String
}

// compose/DAG node (dag.ts:50: outputs / failed / skipped).
enum NodeStatus {
    case pending, running, done, failed, skipped
    var color: Color {
        switch self {
        case .pending: Theme.faint
        case .running: Theme.accent
        case .done: Theme.success
        case .failed: Theme.danger
        case .skipped: Theme.muted
        }
    }
    var symbol: String {
        switch self {
        case .pending: "circle"
        case .running: "circle.dotted"
        case .done: "checkmark"
        case .failed: "xmark"
        case .skipped: "minus"
        }
    }
}

struct ComposeNode: Identifiable {
    let id: String
    var status: NodeStatus
    let label: String
}

struct Panel: Identifiable {
    let id = UUID()
    let title: String
    let badge: String
    let lines: [String]
}

// End-of-turn terminal state. `kind` + ordered fields whose labels match AFK's
// exact protocol (terminal-state.ts:44).
enum TerminalKind: String {
    case done = "DONE"
    case blocked = "BLOCKED"
    case asking = "ASKING"
    case interrupted = "INTERRUPTED"
    var color: Color {
        switch self {
        case .done: Theme.success
        case .blocked: Theme.danger
        case .asking: Theme.amber
        case .interrupted: Theme.faint
        }
    }
    var symbol: String {
        switch self {
        case .done: "checkmark.seal.fill"
        case .blocked: "exclamationmark.octagon.fill"
        case .asking: "questionmark.circle.fill"
        case .interrupted: "pause.circle.fill"
        }
    }
}

struct TerminalField: Identifiable {
    let id = UUID()
    let label: String
    let value: String
}

struct TerminalState {
    let kind: TerminalKind
    let fields: [TerminalField]
}
