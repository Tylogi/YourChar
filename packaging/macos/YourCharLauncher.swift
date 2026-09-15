import AppKit
import Darwin
import Foundation
import WebKit

private enum ReleaseSettings {
  static let host = "127.0.0.1"
  static let defaultPort = 8765

  static var port: Int {
    guard
      let value = ProcessInfo.processInfo.environment["YOURCHAR_PORT"],
      let port = Int(value),
      (1...65535).contains(port)
    else {
      return defaultPort
    }
    return port
  }

  static var baseURL: URL {
    URL(string: "http://\(host):\(port)")!
  }

  static var readinessURL: URL {
    baseURL.appendingPathComponent("api/v1/readiness")
  }
}

private final class BrowserViewController: NSViewController, WKNavigationDelegate, WKUIDelegate {
  private let webView: WKWebView
  private let statusLabel = NSTextField(labelWithString: "Starting YourChar…")

  override init(nibName nibNameOrNil: NSNib.Name?, bundle nibBundleOrNil: Bundle?) {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init(nibName: nibNameOrNil, bundle: nibBundleOrNil)
    webView.navigationDelegate = self
    webView.uiDelegate = self
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func loadView() {
    let container = NSView()
    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

    webView.translatesAutoresizingMaskIntoConstraints = false
    webView.isHidden = true
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.alignment = .center
    statusLabel.font = NSFont.systemFont(ofSize: 15)
    statusLabel.textColor = .secondaryLabelColor

    container.addSubview(webView)
    container.addSubview(statusLabel)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      webView.topAnchor.constraint(equalTo: container.topAnchor),
      webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      statusLabel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
      statusLabel.centerYAnchor.constraint(equalTo: container.centerYAnchor),
      statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 24),
      statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -24),
    ])
    view = container
  }

  func showApplication(at url: URL) {
    statusLabel.isHidden = true
    webView.isHidden = false
    webView.load(URLRequest(url: url))
  }

  func showFailure(_ message: String) {
    webView.isHidden = true
    statusLabel.isHidden = false
    statusLabel.stringValue = message
    statusLabel.textColor = .systemRed
  }

  @objc func reloadApplication(_ sender: Any?) {
    webView.reload()
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    let isOwnedOrigin = url.host == ReleaseSettings.host && url.port == ReleaseSettings.port
    if isOwnedOrigin && navigationAction.targetFrame != nil {
      decisionHandler(.allow)
      return
    }
    openExternalURL(url)
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url {
      openExternalURL(url)
    }
    return nil
  }

  private func openExternalURL(_ url: URL) {
    guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "YourChar"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: view.window!) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "YourChar"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: view.window!) { response in
      completionHandler(response == .alertFirstButtonReturn)
    }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "YourChar"
    alert.informativeText = prompt
    let input = NSTextField(string: defaultText ?? "")
    input.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
    alert.accessoryView = input
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: view.window!) { response in
      completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
    }
  }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let browserController = BrowserViewController(nibName: nil, bundle: nil)
  private var window: NSWindow!
  private var serverProcess: Process?
  private var logHandle: FileHandle?
  private var ownsServer = false
  private var shuttingDown = false
  private var applicationReady = false
  private var stateURL: URL!
  private var logURL: URL!

  func applicationDidFinishLaunching(_ notification: Notification) {
    configureWindow()
    configureMenus()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    guard configureDirectories() else { return }
    attachOrLaunchServer()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    if applicationReady {
      browserController.showApplication(at: ReleaseSettings.baseURL)
    }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    shuttingDown = true
    guard ownsServer, let process = serverProcess, process.isRunning else {
      return .terminateNow
    }
    process.terminationHandler = nil
    process.terminate()
    let deadline = Date().addingTimeInterval(13)
    while process.isRunning && Date() < deadline {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      process.waitUntilExit()
    }
    return .terminateNow
  }

  func applicationWillTerminate(_ notification: Notification) {
    logHandle?.closeFile()
    logHandle = nil
  }

  private func configureDirectories() -> Bool {
    let environment = ProcessInfo.processInfo.environment
    if let configured = environment["YOURCHAR_STATE_DIR"], !configured.isEmpty {
      stateURL = URL(fileURLWithPath: configured, isDirectory: true)
    } else {
      stateURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("YourChar", isDirectory: true)
    }
    let logDirectory = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Logs/YourChar", isDirectory: true)
    logURL = logDirectory.appendingPathComponent("YourChar.log")
    do {
      try FileManager.default.createDirectory(at: stateURL, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateURL.path)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: logDirectory.path)
      return true
    } catch {
      presentFatalError("YourChar could not create its data directories: \(error.localizedDescription)")
      return false
    }
  }

  private func configureWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "YourChar"
    window.contentViewController = browserController
    window.minSize = NSSize(width: 900, height: 620)
    window.center()
    window.setFrameAutosaveName("YourCharMainWindow")
    window.delegate = self
  }

  private func configureMenus() {
    let menu = NSMenu()

    let applicationItem = NSMenuItem()
    menu.addItem(applicationItem)
    let applicationMenu = NSMenu(title: "YourChar")
    applicationItem.submenu = applicationMenu
    applicationMenu.addItem(withTitle: "About YourChar", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    applicationMenu.addItem(NSMenuItem.separator())
    let browserItem = applicationMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser(_:)), keyEquivalent: "b")
    browserItem.target = self
    let dataItem = applicationMenu.addItem(withTitle: "Show Data Folder", action: #selector(showDataFolder(_:)), keyEquivalent: "")
    dataItem.target = self
    let logsItem = applicationMenu.addItem(withTitle: "Show Log", action: #selector(showLog(_:)), keyEquivalent: "")
    logsItem.target = self
    applicationMenu.addItem(NSMenuItem.separator())
    applicationMenu.addItem(withTitle: "Hide YourChar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    applicationMenu.addItem(withTitle: "Quit YourChar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let viewItem = NSMenuItem()
    menu.addItem(viewItem)
    let viewMenu = NSMenu(title: "View")
    viewItem.submenu = viewMenu
    let reloadItem = viewMenu.addItem(withTitle: "Reload", action: #selector(BrowserViewController.reloadApplication(_:)), keyEquivalent: "r")
    reloadItem.target = browserController

    let windowItem = NSMenuItem()
    menu.addItem(windowItem)
    let windowMenu = NSMenu(title: "Window")
    windowItem.submenu = windowMenu
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = menu
  }

  private func attachOrLaunchServer() {
    probeReadiness { [weak self] ready in
      guard let self else { return }
      if ready {
        self.applicationBecameReady()
      } else {
        self.launchServer()
      }
    }
  }

  private func launchServer() {
    guard let resources = Bundle.main.resourceURL else {
      presentFatalError("YourChar has an invalid application bundle.")
      return
    }
    let applicationRoot = resources.appendingPathComponent("app", isDirectory: true)
    let node = resources.appendingPathComponent("runtime/bin/node")
    let server = applicationRoot.appendingPathComponent("dist/src/server.js")
    guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: server.path) else {
      presentFatalError("YourChar is missing its embedded runtime. Reinstall the application.")
      return
    }

    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    do {
      logHandle = try FileHandle(forWritingTo: logURL)
      logHandle?.seekToEndOfFile()
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
      let header = "\n[\(ISO8601DateFormatter().string(from: Date()))] Starting YourChar \(version)\n"
      logHandle?.write(Data(header.utf8))

      let process = Process()
      process.executableURL = node
      process.arguments = ["--disable-warning=ExperimentalWarning", server.path]
      process.currentDirectoryURL = applicationRoot
      var environment = ProcessInfo.processInfo.environment
      environment["HOST"] = ReleaseSettings.host
      environment["PORT"] = String(ReleaseSettings.port)
      environment["YOURCHAR_STATE_DIR"] = stateURL.path
      let bundledPath = resources.appendingPathComponent("runtime/bin").path
      environment["PATH"] = [bundledPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
      process.environment = environment
      process.standardOutput = logHandle
      process.standardError = logHandle
      process.terminationHandler = { [weak self] completed in
        DispatchQueue.main.async {
          guard let self, !self.shuttingDown else { return }
          self.serverProcess = nil
          self.browserController.showFailure("YourChar stopped unexpectedly. Open the log from the YourChar menu for details.")
          self.presentError("YourChar stopped with exit code \(completed.terminationStatus).", includeLogButton: true)
        }
      }
      try process.run()
      serverProcess = process
      ownsServer = true
      beginReadinessPolling(attempt: 0)
    } catch {
      presentFatalError("YourChar could not start: \(error.localizedDescription)")
    }
  }

  private func beginReadinessPolling(attempt: Int) {
    probeReadiness { [weak self] ready in
      guard let self, !self.shuttingDown else { return }
      if ready {
        self.applicationBecameReady()
        return
      }
      if let process = self.serverProcess, !process.isRunning {
        self.browserController.showFailure("YourChar could not start. Open the log from the YourChar menu for details.")
        return
      }
      guard attempt < 119 else {
        self.browserController.showFailure("YourChar did not become ready within 30 seconds.")
        self.presentError("YourChar did not become ready within 30 seconds.", includeLogButton: true)
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        self.beginReadinessPolling(attempt: attempt + 1)
      }
    }
  }

  private func probeReadiness(completion: @escaping (Bool) -> Void) {
    var request = URLRequest(url: ReleaseSettings.readinessURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 1
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let statusCode = (response as? HTTPURLResponse)?.statusCode
      let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let ready = statusCode == 200 && body?["status"] as? String == "ready" && body?["database"] as? String == "ok"
      DispatchQueue.main.async { completion(ready) }
    }.resume()
  }

  private func applicationBecameReady() {
    applicationReady = true
    browserController.showApplication(at: ReleaseSettings.baseURL)
  }

  @objc private func openInBrowser(_ sender: Any?) {
    NSWorkspace.shared.open(ReleaseSettings.baseURL)
  }

  @objc private func showDataFolder(_ sender: Any?) {
    NSWorkspace.shared.activateFileViewerSelecting([stateURL])
  }

  @objc private func showLog(_ sender: Any?) {
    if FileManager.default.fileExists(atPath: logURL.path) {
      NSWorkspace.shared.activateFileViewerSelecting([logURL])
    } else {
      NSWorkspace.shared.open(logURL.deletingLastPathComponent())
    }
  }

  private func presentFatalError(_ message: String) {
    browserController.showFailure(message)
    presentError(message, includeLogButton: false)
  }

  private func presentError(_ message: String, includeLogButton: Bool) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "YourChar"
    alert.informativeText = message
    if includeLogButton {
      alert.addButton(withTitle: "Show Log")
      alert.addButton(withTitle: "Close")
      if alert.runModal() == .alertFirstButtonReturn {
        showLog(nil)
      }
    } else {
      alert.addButton(withTitle: "Close")
      alert.runModal()
    }
  }
}

@main
private struct YourCharApplication {
  private static let delegate = AppDelegate()

  static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    application.run()
  }
}
