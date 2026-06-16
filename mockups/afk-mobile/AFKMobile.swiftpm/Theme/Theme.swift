import SwiftUI

// AFK Dark palette — matched to website/app/globals.css and the "AFK Dark" editor
// theme. Display font is monospaced (the code-first brand vibe). Glass lives on the
// navigation layer only; content surfaces are the solid colors below.
enum Theme {
    static let bg         = Color(hex: 0x07070b)
    static let bgElev     = Color(hex: 0x0d0d14)
    static let surface    = Color(hex: 0x11111a)
    static let elev       = Color(hex: 0x161621)
    static let border     = Color(hex: 0x1f1f2e)
    static let borderSoft = Color(hex: 0x15151f)
    static let accent     = Color(hex: 0xf9854b)
    static let accentSoft = Color(hex: 0xffa07a)
    static let text       = Color(hex: 0xe9e9f0)
    static let muted      = Color(hex: 0x9b9bae)
    static let faint      = Color(hex: 0x8b8ea4)   // lifted from 0x7c7c94 to clear WCAG AA for the smallest labels
    static let success    = Color(hex: 0x4ade80)
    static let amber      = Color(hex: 0xfbbf24)
    static let danger     = Color(hex: 0xf87171)

    static let rSm: CGFloat = 4
    static let r: CGFloat = 8
    static let rLg: CGFloat = 12

    static func mono(_ style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .monospaced).weight(weight)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xff) / 255
        let g = Double((hex >> 8) & 0xff) / 255
        let b = Double(hex & 0xff) / 255
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}
