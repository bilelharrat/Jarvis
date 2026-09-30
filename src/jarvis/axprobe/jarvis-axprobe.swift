// jarvis-axprobe: what JARVIS's mouse and keyboard are about to press, through the Mac's
// accessibility interface, as one line of JSON.
//
//   jarvis-axprobe focus         the app in front, its window's title, and the focused
//                                element (a message box, a button)
//   jarvis-axprobe point X Y     the same, plus the element under the point (global screen
//                                points, top-left origin), its app, and the button, link
//                                or menu item a click there would press
//
// Read-only: it never performs an action or changes a value. Each element is described by
// its role, subrole, title, description, help, identifier and value (cut short), and
// whether its value can be set (a text box). "trusted" says whether this Mac lets the app
// running JARVIS read other apps at all (Accessibility): without it, nothing but the app's
// name comes back.

import AppKit
import ApplicationServices
import Foundation

let pressable: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton",
    "AXCheckBox", "AXRadioButton", "AXTab", "AXDisclosureTriangle", "AXCell", "AXRow",
]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func asElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func text(_ element: AXUIElement, _ name: String, limit: Int = 300) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let string = value as? String { return String(string.prefix(limit)) }
    if let attributed = value as? NSAttributedString { return String(attributed.string.prefix(limit)) }
    return ""
}

func describe(_ element: AXUIElement) -> [String: Any] {
    var settable = DarwinBoolean(false)
    let canSet = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    return [
        "role": text(element, kAXRoleAttribute),
        "subrole": text(element, kAXSubroleAttribute),
        "title": text(element, kAXTitleAttribute),
        "description": text(element, kAXDescriptionAttribute),
        "help": text(element, kAXHelpAttribute),
        "identifier": text(element, "AXIdentifier"),
        "placeholder": text(element, "AXPlaceholderValue"),
        "value": text(element, kAXValueAttribute, limit: 2000),
        "editable": canSet == .success && settable.boolValue,
    ]
}

// What a click on this element presses: itself, or the nearest pressable one around it
// (the button a label or an icon sits in).
func pressTarget(_ start: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = start
    for _ in 0..<8 {
        guard let element = current else { return nil }
        if pressable.contains(text(element, kAXRoleAttribute)) { return element }
        current = asElement(attribute(element, kAXParentAttribute))
    }
    return nil
}

func appInfo(_ pid: pid_t) -> [String: Any] {
    let app = NSRunningApplication(processIdentifier: pid)
    return ["name": app?.localizedName ?? "", "bundle": app?.bundleIdentifier ?? ""]
}

let args = CommandLine.arguments
var out: [String: Any] = ["trusted": AXIsProcessTrusted()]
if let front = NSWorkspace.shared.frontmostApplication {
    out["app"] = front.localizedName ?? ""
    out["bundle"] = front.bundleIdentifier ?? ""
    let app = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 1.0)
    if let window = asElement(attribute(app, kAXFocusedWindowAttribute)) {
        out["window"] = text(window, kAXTitleAttribute)
    }
    if let focused = asElement(attribute(app, kAXFocusedUIElementAttribute)) {
        out["focused"] = describe(focused)
    }
}
if args.count >= 4, args[1] == "point", let x = Float(args[2]), let y = Float(args[3]) {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1.0)
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(system, x, y, &hit) == .success, let hit {
        out["at"] = describe(hit)
        var pid: pid_t = 0
        if AXUIElementGetPid(hit, &pid) == .success {
            let owner = appInfo(pid)
            out["at_app"] = owner["name"]
            out["at_bundle"] = owner["bundle"]
            let app = AXUIElementCreateApplication(pid)
            if let window = asElement(attribute(app, kAXFocusedWindowAttribute)) {
                out["at_window"] = text(window, kAXTitleAttribute)
            }
            if let focused = asElement(attribute(app, kAXFocusedUIElementAttribute)) {
                out["at_focused"] = describe(focused)
            }
        }
        if let target = pressTarget(hit) { out["press"] = describe(target) }
    }
}
if let data = try? JSONSerialization.data(withJSONObject: out),
    let line = String(data: data, encoding: .utf8)
{
    print(line)
} else {
    print("{}")
}
