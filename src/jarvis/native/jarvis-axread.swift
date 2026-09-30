// jarvis-axread: what's in an app, through the Mac's accessibility interface, as one line
// of JSON.
//
//   jarvis-axread controls [limit]          the app in front: its focused window's controls
//                                           (role, name, value, where), breadth first, at
//                                           most limit of them, and its menu bar's menus
//   jarvis-axread webtext <bundle> [limit]  the text of the page in front in that browser
//                                           (Chrome, Edge, Brave, Arc), at most limit
//                                           characters, with its title and address
//
// Read-only: it never presses, types or changes a value. The one thing it sets is
// Chromium's AXManualAccessibility on the browser, the switch Chromium offers assistive
// apps so its pages' accessibility tree is filled in (it stays on until the browser quits
// and changes none of the owner's settings). "trusted" says whether this Mac lets the app
// running JARVIS read other apps at all (Accessibility).

import AppKit
import ApplicationServices
import Foundation

let started = Date()
let budget: TimeInterval = 6.0  // seconds for a whole answer, however big the app

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

func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let value = attribute(element, name) as? [AnyObject] else { return [] }
    return value.compactMap { asElement($0 as CFTypeRef) }
}

func text(_ element: AXUIElement, _ name: String, limit: Int = 200) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let string = value as? String { return String(string.prefix(limit)) }
    if let attributed = value as? NSAttributedString { return String(attributed.string.prefix(limit)) }
    if let number = value as? NSNumber { return number.stringValue }
    if let url = value as? URL { return url.absoluteString }
    return ""
}

func flag(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = attribute(element, name) as? NSNumber else { return nil }
    return value.boolValue
}

func frame(_ element: AXUIElement) -> [String: Int]? {
    guard let position = attribute(element, kAXPositionAttribute),
        let size = attribute(element, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return ["x": Int(point.x), "y": Int(point.y), "w": Int(extent.width), "h": Int(extent.height)]
}

func outOfTime() -> Bool { Date().timeIntervalSince(started) > budget }

func window(of app: AXUIElement) -> AXUIElement? {
    asElement(attribute(app, kAXFocusedWindowAttribute))
        ?? asElement(attribute(app, kAXMainWindowAttribute))
        ?? elements(app, kAXWindowsAttribute).first
}

// Controls worth naming: what can be pressed, typed into, chosen or read as a label.
let wanted: Set<String> = [
    "AXButton", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
    "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXTab",
    "AXTabGroup", "AXDisclosureTriangle", "AXStaticText", "AXHeading", "AXImage", "AXCell",
    "AXRow", "AXIncrementor", "AXColorWell", "AXSegmentedControl", "AXToolbar",
]

func controls(limit: Int) -> [String: Any] {
    var out: [String: Any] = ["trusted": AXIsProcessTrusted()]
    guard let front = NSWorkspace.shared.frontmostApplication else { return out }
    out["app"] = front.localizedName ?? ""
    out["bundle"] = front.bundleIdentifier ?? ""
    let app = AXUIElementCreateApplication(front.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 1.0)
    if let bar = asElement(attribute(app, kAXMenuBarAttribute)) {
        out["menus"] = elements(bar, kAXChildrenAttribute).prefix(20).map { text($0, kAXTitleAttribute) }
            .filter { !$0.isEmpty }
    }
    guard let win = window(of: app) else { return out }
    out["window"] = text(win, kAXTitleAttribute)
    var found: [[String: Any]] = []
    var queue: [(AXUIElement, Int)] = [(win, 0)]
    var next = 0  // the queue's front: taking from it never shifts the rest
    var seen = 0
    var truncated = false
    while next < queue.count {
        if found.count >= limit || seen >= 5000 || outOfTime() {
            truncated = true
            break
        }
        let (element, depth) = queue[next]
        next += 1
        seen += 1
        let role = text(element, kAXRoleAttribute)
        if wanted.contains(role) {
            var row: [String: Any] = ["role": role, "depth": depth]
            for (key, name) in [
                ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
                ("value", kAXValueAttribute), ("help", kAXHelpAttribute),
                ("placeholder", "AXPlaceholderValue"), ("subrole", kAXSubroleAttribute),
            ] {
                let value = text(element, name, limit: key == "value" ? 300 : 120)
                if !value.isEmpty { row[key] = value }
            }
            if flag(element, kAXEnabledAttribute) == false { row["enabled"] = false }
            if flag(element, kAXFocusedAttribute) == true { row["focused"] = true }
            if let where_ = frame(element) { row["frame"] = where_ }
            let named = ["title", "description", "value", "help", "placeholder"].contains { row[$0] != nil }
            if named || role != "AXStaticText" { found.append(row) }
        }
        if depth < 40 {
            for child in elements(element, kAXChildrenAttribute) { queue.append((child, depth + 1)) }
        }
    }
    out["controls"] = found
    out["truncated"] = truncated
    return out
}

// Where a page's text starts a new line.
let blocks: Set<String> = [
    "AXHeading", "AXGroup", "AXList", "AXListItem", "AXRow", "AXCell", "AXTable",
    "AXParagraph", "AXBlockquote", "AXArticle", "AXSection", "AXLandmarkMain",
]

func findWebArea(_ root: AXUIElement) -> AXUIElement? {
    var stack: [AXUIElement] = [root]
    var seen = 0
    while let element = stack.popLast(), seen < 20000, !outOfTime() {
        seen += 1
        if text(element, kAXRoleAttribute) == "AXWebArea" { return element }
        stack.append(contentsOf: elements(element, kAXChildrenAttribute).reversed())
    }
    return nil
}

func pageText(_ area: AXUIElement, limit: Int) -> (String, Bool) {
    var out = ""
    var length = 0  // out's characters, counted as they're added (String.count walks it all)
    var stack: [(AXUIElement, Bool)] = [(area, false)]
    var seen = 0
    while let item = stack.popLast() {
        let (element, closing) = item
        if closing {
            if !out.isEmpty && !out.hasSuffix("\n") {
                out += "\n"
                length += 1
            }
            continue
        }
        seen += 1
        if length >= limit || seen >= 40000 || outOfTime() { return (String(out.prefix(limit)), true) }
        let role = text(element, kAXRoleAttribute)
        if role == "AXStaticText" {
            let value = text(element, kAXValueAttribute, limit: 4000)
            if !value.isEmpty {
                if !out.isEmpty && !out.hasSuffix("\n") && !out.hasSuffix(" ") {
                    out += " "
                    length += 1
                }
                out += value
                length += value.count
            }
            continue
        }
        if blocks.contains(role) { stack.append((element, true)) }
        for child in elements(element, kAXChildrenAttribute).reversed() { stack.append((child, false)) }
    }
    return (out, false)
}

func webtext(bundle: String, limit: Int) -> [String: Any] {
    var out: [String: Any] = ["trusted": AXIsProcessTrusted(), "found": false]
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
    else { return out }
    out["app"] = running.localizedName ?? ""
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 1.5)
    guard let win = window(of: app) else { return out }
    out["title"] = text(win, kAXTitleAttribute)
    var area = findWebArea(win)
    var (body, truncated) = area.map { pageText($0, limit: limit) } ?? ("", false)
    if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        // Chromium fills its pages' tree in only for assistive apps that ask.
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        Thread.sleep(forTimeInterval: 0.6)
        area = findWebArea(win)
        (body, truncated) = area.map { pageText($0, limit: limit) } ?? ("", false)
    }
    if let area {
        out["found"] = true
        out["url"] = text(area, "AXURL", limit: 2000)
    }
    out["text"] = body
    out["truncated"] = truncated
    return out
}

let args = CommandLine.arguments
var answer: [String: Any]
if args.count >= 2, args[1] == "controls" {
    answer = controls(limit: args.count >= 3 ? max(1, min(1000, Int(args[2]) ?? 300)) : 300)
} else if args.count >= 3, args[1] == "webtext" {
    answer = webtext(bundle: args[2], limit: args.count >= 4 ? max(100, min(100_000, Int(args[3]) ?? 20000)) : 20000)
} else {
    answer = ["error": "usage: controls [limit] | webtext <bundle> [limit]"]
}
if let data = try? JSONSerialization.data(withJSONObject: answer),
    let line = String(data: data, encoding: .utf8)
{
    print(line)
} else {
    print("{}")
}
