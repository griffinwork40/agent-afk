import SwiftUI

// Single source of truth. @Observable → property-level SwiftUI tracking
// (Observation framework). Holds the session fleet, selection, filter, search,
// and per-command collapse state, plus the mutation methods the UI drives.
@Observable
final class AppModel {
    var sessions: [Session]
    var selectedSessionID: String?
    var filter: SessionFilter = .all
    var search: String = ""
    var collapsed: Set<String> = []     // collapsed command-group names
    var showNewSession = false

    init(sessions: [Session]) {
        self.sessions = sessions
        // Mission control surfaces what needs you first, then live work, then anything.
        self.selectedSessionID =
            sessions.first(where: { $0.status.needsYou })?.id
            ?? sessions.first(where: { $0.status.isLive })?.id
            ?? sessions.first?.id
    }

    static func demo() -> AppModel {
        let model = AppModel(sessions: MockData.sessions)
        // Optional launch override (screenshots/deep-link):
        // AFK_DEFAULT=none|running|asking|blocked|done|interrupted
        if let key = ProcessInfo.processInfo.environment["AFK_DEFAULT"] {
            if key == "none" {
                model.selectedSessionID = nil
            } else if let status = SessionStatus(rawValue: key),
                      let match = model.sessions.first(where: { $0.status == status }) {
                model.selectedSessionID = match.id
            }
        }
        return model
    }

    var filteredSessions: [Session] {
        sessions.filter { s in
            let matchesFilter: Bool
            switch filter {
            case .all: matchesFilter = true
            case .running: matchesFilter = s.status.isLive
            case .needsYou: matchesFilter = s.status.needsYou
            }
            let q = search.trimmingCharacters(in: .whitespaces)
            let matchesSearch = q.isEmpty
                || s.title.localizedCaseInsensitiveContains(q)
                || s.command.name.localizedCaseInsensitiveContains(q)
            return matchesFilter && matchesSearch
        }
    }

    // Sessions grouped by spawning slash command, preserving first-seen order.
    var groups: [(command: SlashCommand, sessions: [Session])] {
        var order: [SlashCommand] = []
        var map: [String: [Session]] = [:]
        for s in filteredSessions {
            if map[s.command.name] == nil { order.append(s.command) }
            map[s.command.name, default: []].append(s)
        }
        return order.map { ($0, map[$0.name] ?? []) }
    }

    var selectedSession: Session? {
        guard let id = selectedSessionID else { return nil }
        return sessions.first { $0.id == id }
    }

    var needsYouCount: Int { sessions.filter { $0.status.needsYou }.count }
    var runningCount: Int { sessions.filter { $0.status.isLive }.count }

    func isExpanded(_ command: String) -> Bool { !collapsed.contains(command) }
    func toggle(_ command: String) {
        if collapsed.contains(command) { collapsed.remove(command) } else { collapsed.insert(command) }
    }

    private func index(of id: String) -> Int? { sessions.firstIndex { $0.id == id } }

    func sendUserMessage(_ text: String, to id: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let i = index(of: id), !trimmed.isEmpty else { return }
        sessions[i].messages.append(Message(kind: .user(trimmed)))
        sessions[i].status = .running
        sessions[i].turns += 1
        sessions[i].messages.append(Message(kind: .agentText(
            "Got it — continuing on `\(trimmed)`. I'll pick this up and report back with a terminal state.")))
    }

    func answerElicitation(_ answer: String, for id: String) {
        guard let i = index(of: id) else { return }
        sessions[i].pendingElicitation = nil
        sessions[i].status = .running
        sessions[i].messages.append(Message(kind: .user(answer)))
        sessions[i].messages.append(Message(kind: .agentText(
            "Thanks — proceeding with **\(answer)**. Resuming the task now.")))
    }

    func newSession(command: SlashCommand) {
        let id = "\(command.name.dropFirst())-\(Int.random(in: 1000...9999))"
        let s = Session(
            id: id,
            command: command,
            title: "new \(command.name.dropFirst()) run",
            status: .running,
            model: "sonnet",
            surface: .repl,
            elapsed: "0s",
            turns: 1,
            tokens: 0,
            tokenSeries: [0, 1, 0, 2, 1],
            messages: [
                Message(kind: .user("\(command.name) …")),
                Message(kind: .agentText("Starting `\(command.name)`. Spinning up the first wave…")),
                Message(kind: .agentStreaming("Reading the working tree and prior-session memory to ground this run before any edit."))
            ],
            pendingElicitation: nil
        )
        sessions.insert(s, at: 0)
        selectedSessionID = id
        showNewSession = false
    }
}
