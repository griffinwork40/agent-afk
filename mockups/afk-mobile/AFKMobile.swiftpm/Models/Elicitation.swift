import SwiftUI

// Mirrors AFK's elicitation/ask_question request (src/agent/types/sdk-types.ts:192,
// elicitation-router.ts). When a session is `asking`, the composer transforms into
// the matching answer affordance for this type — the killer mobile flow.
enum ElicitationType {
    case text, confirm, choice, multiChoice, number
    var label: String {
        switch self {
        case .text: "text"
        case .confirm: "confirm"
        case .choice: "choice"
        case .multiChoice: "multi"
        case .number: "number"
        }
    }
}

struct Elicitation {
    let type: ElicitationType
    let message: String
    var context: String? = nil
    var choices: [String] = []
    var allowSkip: Bool = false
    var allowCustom: Bool = false
    var minValue: Double? = nil
    var maxValue: Double? = nil
    var defaultText: String? = nil
    var assumption: String? = nil   // shown in the composer's "details" disclosure
    var followup: String? = nil     // shown in the composer's "details" disclosure
}
