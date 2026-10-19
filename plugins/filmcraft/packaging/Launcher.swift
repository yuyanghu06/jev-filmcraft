import AppKit
import Foundation

// Keep the app launcher alive for the local service. FilmCraft owns the editor window and its Quit action.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let process = Process()
let bundle = Bundle.main.bundleURL
let resources = bundle.appendingPathComponent("Contents/Resources")
process.executableURL = resources.appendingPathComponent("node/bin/node")
process.arguments = [resources.appendingPathComponent("runtime/launch.mjs").path, "desktop"]
var environment = ProcessInfo.processInfo.environment
environment.removeValue(forKey: "NODE_OPTIONS")
environment.removeValue(forKey: "NODE_PATH")
process.environment = environment
process.currentDirectoryURL = resources
process.standardOutput = FileHandle.nullDevice
process.standardError = FileHandle.nullDevice

func showFailure() {
    let alert = NSAlert()
    alert.messageText = "Jev FilmCraft could not start"
    alert.informativeText = "Close any other Jev FilmCraft window and try again. If it still fails, check providers.json in ~/Library/Application Support/Jev FilmCraft, or download a fresh copy of the app. Your projects have not been removed."
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Open Settings Folder")
    application.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertSecondButtonReturn {
        let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Jev FilmCraft")
        NSWorkspace.shared.open(folder)
    }
}

process.terminationHandler = { child in
    DispatchQueue.main.async {
        if child.terminationStatus != 0 { showFailure() }
        application.terminate(nil)
    }
}
do {
    try process.run()
    application.run()
} catch {
    showFailure()
    exit(1)
}
