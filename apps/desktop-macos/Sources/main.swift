import AppKit
import WebKit

/// Blade Notes for macOS: one native window around the web app. The web app keeps its
/// data in WebKit's persistent store, so sign-in and offline notes survive restarts.
/// Links that leave the app (and its sign-in page) open in the default browser.
let appURL = URL(string: Bundle.main.object(forInfoDictionaryKey: "AppURL") as? String ?? "https://notes.mirsabbiralam.com")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "bridge")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.setValue(false, forKey: "drawsBackground") // no white flash in dark mode

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Blade Notes"
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = web
        window.setFrameAutosaveName("Main")
        if window.frame.origin == .zero { window.center() }
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.mainMenu = makeMenu()
        web.load(URLRequest(url: appURL))
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { window.makeKeyAndOrderFront(nil) }
        return true
    }

    // MARK: links

    private func isInternal(_ url: URL) -> Bool {
        guard let host = url.host else { return url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" }
        return host == appURL.host || host.hasSuffix(".amazoncognito.com")
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .allow }
        if isInternal(url) { return .allow }
        NSWorkspace.shared.open(url)
        return .cancel
    }

    /// target="_blank" and window.open: open in the browser instead of a new web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if isInternal(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        return nil
    }

    /// The web app uses confirm() before moving something to the trash.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    /// No network on start-up: show a plain message with a retry instead of a blank window.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
            <body style="font:15px -apple-system;display:grid;place-items:center;height:100vh;margin:0;color:#555e6f">
            <div style="text-align:center"><p>Can't reach Blade Notes.</p><p>\(error.localizedDescription)</p>
            <button onclick="location.href='\(appURL.absoluteString)'" style="font:inherit;padding:6px 14px">Try again</button></div></body>
            """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: bridge (window.webkit.messageHandlers.bridge)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else { return (nil, "bad message") }
        let params = body["params"] as? [String: Any] ?? [:]
        do {
            switch method {
            case "appInfo":
                return (["platform": "macos", "version": Updater.current], nil)
            case "checkForUpdate":
                return (await Updater.check(force: params["force"] as? Bool ?? false), nil)
            case "installUpdate":
                try await Updater.install()
                NSApp.terminate(nil)
                return (nil, nil)
            default:
                return (nil, "unknown method \(method)")
            }
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    // MARK: menu

    @objc func reload() { web.load(URLRequest(url: appURL)) }
    @objc func checkForUpdates() {
        web.evaluateJavaScript("window.__hostEvent && window.__hostEvent('openUpdates')")
    }

    private func makeMenu() -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            item.submenu = menu
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        submenu("Blade Notes", [
            item("About Blade Notes", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            item("Check for Updates…", #selector(checkForUpdates)),
            .separator(),
            item("Hide Blade Notes", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            item("Quit Blade Notes", #selector(NSApplication.terminate(_:)), "q"),
        ])
        // WKWebView only gets ⌘C/⌘V/⌘Z etc. through these standard Edit menu actions.
        submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        submenu("View", [
            item("Reload", #selector(reload), "r"),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
