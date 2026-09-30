// jarvis-look: what is in front of the owner when they press the look-at-this key
// (codelook.py builds it with swiftc on first use and runs it once per press).
//
// Prints one JSON object and exits:
//   app, bundle, pid   the app in front
//   window, bounds     its front window (CGWindowList: the number screencapture -l takes)
//   title              that window's title (Accessibility, else the window list)
//   selected           the text selected in the focused element, read through Accessibility
//                      (never the clipboard); left out when nothing is selected or it can't
//                      be read
//   ax                 whether Accessibility is allowed for J.A.R.V.I.S.
// It changes nothing: it only reads.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let selectedLimit = 8000  // characters of selected text passed on

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func element(_ value: AnyObject?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

var out: [String: Any] = [:]
let front = NSWorkspace.shared.frontmostApplication
let pid = front?.processIdentifier ?? 0
out["app"] = front?.localizedName ?? ""
out["bundle"] = front?.bundleIdentifier ?? ""
out["pid"] = Int(pid)

// The front window: the app's first on-screen window in the normal layer (the list runs
// front to back).
if pid != 0,
    let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
{
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
            (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        else { continue }
        out["window"] = (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
        if let name = info[kCGWindowName as String] as? String, !name.isEmpty {
            out["title"] = name
        }
        if let bounds = info[kCGWindowBounds as String] as? [String: Any] {
            out["bounds"] = bounds
        }
        break
    }
}

let trusted = AXIsProcessTrusted()
out["ax"] = trusted
if trusted && pid != 0 {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    if let window = element(attribute(app, kAXFocusedWindowAttribute as String)),
        let title = attribute(window, kAXTitleAttribute as String) as? String, !title.isEmpty
    {
        out["title"] = title
    }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 1.0)
    if let focused = element(attribute(system, kAXFocusedUIElementAttribute as String)),
        let text = attribute(focused, kAXSelectedTextAttribute as String) as? String
    {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            out["selected"] = String(trimmed.prefix(selectedLimit))
        }
    }
}

if let data = try? JSONSerialization.data(withJSONObject: out, options: []) {
    FileHandle.standardOutput.write(data)
}
