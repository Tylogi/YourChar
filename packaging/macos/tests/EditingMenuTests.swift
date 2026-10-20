import AppKit
import WebKit

private final class Navigation: NSObject, WKNavigationDelegate {
  var ready = false
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true }
}

@main
private struct EditingMenuTests {
  private enum Failure: Error { case check(String) }

  static func require(_ condition: Bool, _ description: String) throws {
    if !condition { throw Failure.check(description) }
  }

  static func wait(_ description: String, until condition: () throws -> Bool) throws {
    let deadline = Date().addingTimeInterval(15)
    while try !condition() && Date() < deadline {
      if let event = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) {
        NSApp.sendEvent(event)
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.001))
    }
    try require(try condition(), description)
  }

  static func javascript(_ webView: WKWebView, _ script: String) throws -> Any? {
    var completed = false
    var result: Any?
    var failure: Error?
    webView.evaluateJavaScript(script) { value, error in
      result = value
      failure = error
      completed = true
    }
    try wait("JavaScript completion") { completed }
    try require(failure == nil, "Synthetic editor JavaScript failed")
    return result
  }

  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.finishLaunching()
    var status: Int32 = 0
    do { try run() } catch {
      fputs("macOS editing test failed: \(error)\n", stderr)
      status = 1
    }
    if CommandLine.arguments.count > 1 {
      try? String(status).write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
    }
    exit(status)
  }

  static func run() throws {
    let app = NSApplication.shared
    let root = NSMenu()
    let applicationItem = NSMenuItem()
    applicationItem.submenu = NSMenu(title: "Editing Tests")
    root.addItem(applicationItem)
    let edit = EditingMenu.make()
    let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    editItem.submenu = edit
    root.addItem(editItem)
    app.mainMenu = root

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 240), configuration: configuration)
    let navigation = Navigation()
    webView.navigationDelegate = navigation
    let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    defer { window.orderOut(nil) }
    print("Test application activation: active=\(app.isActive), keyWindow=\(window.isKeyWindow), canBecomeKey=\(window.canBecomeKey), bundle=\(Bundle.main.bundleIdentifier ?? "none")")
    try wait("Native window activated") { app.isActive && window.isKeyWindow }
    webView.loadHTMLString("<textarea id='editor'>copy-中文-🙂</textarea>", baseURL: nil)
    try wait("Synthetic editor loaded") { navigation.ready }
    window.makeFirstResponder(webView)

    let pasteboard = NSPasteboard.general
    // Preserve the build user's clipboard in memory; never print or persist it.
    let original = (pasteboard.pasteboardItems ?? []).map { item -> NSPasteboardItem in
      let saved = NSPasteboardItem()
      for type in item.types { if let data = item.data(forType: type) { saved.setData(data, forType: type) } }
      return saved
    }
    var ownedChange = pasteboard.changeCount
    defer {
      if pasteboard.changeCount == ownedChange {
        pasteboard.clearContents()
        if !original.isEmpty { pasteboard.writeObjects(original) }
      }
    }
    func seed(_ text: String) throws {
      pasteboard.clearContents()
      try require(pasteboard.setString(text, forType: .string), "Synthetic clipboard setup")
      ownedChange = pasteboard.changeCount
    }
    func key(_ character: String, shifted: Bool = false) throws {
      edit.update()
      let modifiers: NSEvent.ModifierFlags = shifted ? [.command, .shift] : [.command]
      let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
        windowNumber: window.windowNumber, context: nil, characters: shifted ? character.uppercased() : character,
        charactersIgnoringModifiers: character, isARepeat: false, keyCode: 0)!
      try require(root.performKeyEquivalent(with: event), "Editing shortcut was not handled")
    }
    func nativeAction(_ name: String) throws {
      let action = NSSelectorFromString(name + ":")
      try require(app.sendAction(action, to: nil, from: webView), "Native editing action was not handled")
    }
    func contextMenuAction(_ title: String) throws {
      var completed = false
      var enabled = false
      let observer = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { notification in
        guard let menu = notification.object as? NSMenu, menu !== root, menu !== edit else { return }
        RunLoop.main.perform(inModes: [.eventTracking, .default]) {
          if let index = menu.items.firstIndex(where: { $0.title == title }) {
            enabled = menu.items[index].isEnabled
            if enabled { menu.performActionForItem(at: index) }
          }
          menu.cancelTrackingWithoutAnimation()
          completed = true
        }
      }
      defer { NotificationCenter.default.removeObserver(observer) }
      let point = NSPoint(x: 20, y: window.contentView!.bounds.height - 20)
      let event = NSEvent.mouseEvent(with: .rightMouseDown, location: point, modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
      window.sendEvent(event)
      try wait("WebKit context menu opened") { completed }
      try require(enabled, "WebKit context-menu \(title) was enabled")
    }
    func editorValue() throws -> String { try javascript(webView, "document.getElementById('editor').value") as! String }

    try seed("synthetic clipboard")
    _ = try javascript(webView, "document.getElementById('editor').focus(); document.getElementById('editor').select(); true")
    try wait("Native copy command enabled") { edit.update(); return edit.item(withTitle: "Copy")!.isEnabled }
    print("Native editor focused; copy command enabled.")
    try key("c")
    try wait("Command-C copied selected text") { pasteboard.string(forType: .string) == "copy-中文-🙂" }
    ownedChange = pasteboard.changeCount
    _ = try javascript(webView, "document.getElementById('editor').value=''; true")
    try seed("paste-中文-🙂")
    try key("v")
    try wait("Command-V pasted text") { try editorValue() == "paste-中文-🙂" }
    try key("a")
    try key("x")
    try wait("Command-X cut text") { try editorValue().isEmpty && pasteboard.string(forType: .string) == "paste-中文-🙂" }
    ownedChange = pasteboard.changeCount
    try key("z")
    try wait("Command-Z restored text") { try editorValue() == "paste-中文-🙂" }
    try key("z", shifted: true)
    try wait("Shift-Command-Z redid the cut") { try editorValue().isEmpty }

    try seed("native-paste-中文-🙂")
    try nativeAction("paste")
    try wait("Native paste inserted text") { try editorValue() == "native-paste-中文-🙂" }
    try nativeAction("selectAll")
    try nativeAction("copy")
    try wait("Native copy copied text") { pasteboard.string(forType: .string) == "native-paste-中文-🙂" }
    ownedChange = pasteboard.changeCount

    _ = try javascript(webView, "document.getElementById('editor').value=''; true")
    try seed("context-paste-中文-🙂")
    try contextMenuAction("Paste")
    try wait("Context-menu paste inserted text") { try editorValue() == "context-paste-中文-🙂" }
    try nativeAction("selectAll")
    try contextMenuAction("Copy")
    try wait("Context-menu copy copied text") { pasteboard.string(forType: .string) == "context-paste-中文-🙂" }
    ownedChange = pasteboard.changeCount
    print("macOS editing passed: Command-C/V/X/A/Z, redo, native actions, and WebKit context-menu copy/paste with Unicode text.")
  }
}
