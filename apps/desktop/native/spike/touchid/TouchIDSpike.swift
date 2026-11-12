// DESK-TOUCHID-SPIKE: a tiny owner-local test app (never shipped) that tells apart why the Touch ID
// sheet raised by the presence helper ignores the sensor. Four buttons, one per hypothesis:
//   A  as today: the code field is focused (macOS "secure input" on, like Chromium's password field),
//      the real agentlink-presence helper runs `ecdh setup` (the key operation raises the sheet)
//   B  same helper, but the code field is unfocused first (secure input off)
//   C  in this app's own process (frontmost GUI app, like Electron's promptTouchID): evaluatePolicy,
//      then the Secure Enclave key with that context; code field focused (secure input on)
//   D  helper variant: evaluatePolicy first, then the key with that context; code field focused
// Each run appends ONE fixed line to ~/Library/Logs/AgentLink/core.log:
//   touchid spike: variant=<A-D> secure_input=<0|1> exit=<n> diag=<stage>_<domain>_<code> seconds=<n>
// The Secure Enclave key is a fresh throwaway made at launch (no keychain item); the ECDH secret is
// never printed, logged or kept.
import AppKit
import Carbon
import CryptoKit
import LocalAuthentication

final class Spike: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let field = NSSecureTextField(frame: NSRect(x: 20, y: 250, width: 420, height: 24))
  let status = NSTextField(labelWithString: "Preparing…")
  var record: Data?
  var busy = false
  let helpers = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers")

  func applicationDidFinishLaunching(_ n: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 330), styleMask: [.titled, .closable],
      backing: .buffered, defer: false)
    window.title = "AgentLink Touch ID test"
    let v = window.contentView!
    let intro = NSTextField(
      wrappingLabelWithString:
        "Type anything in the box (like your master code), then press A, B, C and D one after another. Touch the sensor each time the Touch ID box appears.")
    intro.frame = NSRect(x: 20, y: 280, width: 420, height: 40)
    v.addSubview(intro)
    field.placeholderString = "type anything here"
    v.addSubview(field)
    let names = ["A", "B", "C", "D"]
    for (i, name) in names.enumerated() {
      let b = NSButton(title: "Try \(name)", target: self, action: #selector(run(_:)))
      b.frame = NSRect(x: 20 + i * 105, y: 200, width: 100, height: 32)
      b.tag = i
      v.addSubview(b)
    }
    status.frame = NSRect(x: 20, y: 20, width: 420, height: 170)
    status.maximumNumberOfLines = 10
    status.lineBreakMode = .byWordWrapping
    v.addSubview(status)
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window.makeFirstResponder(field)
    DispatchQueue.global().async {
      let (code, out, _) = self.spawn("agentlink-presence", ["create"], stdin: nil, timeout: 20)
      DispatchQueue.main.async {
        if code == 0, let out = out {
          self.record = out
          self.status.stringValue = "Ready."
        } else {
          self.status.stringValue = "Could not prepare (exit \(code)). Tell Claude."
          self.log("variant=prep secure_input=0 exit=\(code) diag=none seconds=0")
        }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  /// Runs a helper; stdout is returned (only `create` prints anything), stderr kept only if fixed-shape.
  func spawn(_ name: String, _ args: [String], stdin: Data?, timeout: Double) -> (Int32, Data?, String) {
    let p = Process()
    p.executableURL = helpers.appendingPathComponent(name)
    p.arguments = args
    p.environment = [:]
    let i = Pipe(), o = Pipe(), e = Pipe()
    p.standardInput = i
    p.standardOutput = o
    p.standardError = e
    do { try p.run() } catch { return (-1, nil, "none") }
    if let s = stdin { i.fileHandleForWriting.write(s) }
    try? i.fileHandleForWriting.close()
    let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    let out = o.fileHandleForReading.readDataToEndOfFile()
    let err = e.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    killer.cancel()
    return (p.terminationStatus, name == "agentlink-presence" && args == ["create"] ? out : nil,
      fixedDiag(err))
  }

  func fixedDiag(_ d: Data) -> String {
    let s = String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = s.split(separator: " ")
    guard parts.count == 3, parts[0].allSatisfy({ $0.isLetter }), parts[1].allSatisfy({ $0.isLetter }),
      Int(parts[2]) != nil, s.count < 40
    else { return "none" }
    return parts.joined(separator: "_")
  }

  func log(_ line: String) {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/AgentLink/core.log")
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    if let h = try? FileHandle(forWritingTo: url) {
      h.seekToEndOfFile()
      h.write("touchid spike: \(line)\n".data(using: .utf8)!)
      try? h.close()
    }
  }

  @objc func run(_ sender: NSButton) {
    guard !busy, let rec = record else { return }
    let variant = ["A", "B", "C", "D"][sender.tag]
    if variant == "B" { window.makeFirstResponder(nil) } else { window.makeFirstResponder(field) }
    // Let AppKit apply the focus change (and secure input) before measuring and spawning.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      let secure = IsSecureEventInputEnabled() ? 1 : 0
      self.busy = true
      self.status.stringValue = "Test \(variant): touch the sensor when the Touch ID box appears…"
      let hex = rec  // the helper's `create` output: the record as hex text + "\n"
      let started = Date()
      DispatchQueue.global().async {
        var code: Int32 = 0
        var diag = "none"
        switch variant {
        case "A", "B":
          (code, _, diag) = self.spawn("agentlink-presence", ["ecdh", "setup"], stdin: hex, timeout: 30)
        case "D":
          (code, _, diag) = self.spawn("touchid-spike-helper", ["ecdh-eval"], stdin: hex, timeout: 30)
        default:
          (code, diag) = self.inProcess(rec)
        }
        let secs = Int(Date().timeIntervalSince(started))
        DispatchQueue.main.async {
          self.busy = false
          let word = code == 0 ? "WORKED" : (code == 10 ? "cancelled" : "did not work")
          self.status.stringValue += "\nTest \(variant): \(word) (exit \(code), \(secs) s)"
          self.log("variant=\(variant) secure_input=\(secure) exit=\(code) diag=\(diag) seconds=\(secs)")
        }
      }
    }
  }

  /// Variant C: the sheet belongs to this frontmost app's own process.
  func inProcess(_ rec: Data) -> (Int32, String) {
    let b = [UInt8](rec)
    // The helper printed hex; `record` holds that hex text. Decode it.
    let text = String(decoding: b, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    var bytes = [UInt8]()
    var i = text.startIndex
    while i < text.endIndex {
      let j = text.index(i, offsetBy: 2, limitedBy: text.endIndex) ?? text.endIndex
      guard let v = UInt8(text[i..<j], radix: 16) else { return (65, "input_none_0") }
      bytes.append(v)
      i = j
    }
    guard bytes.count > 3 else { return (65, "input_none_0") }
    let len = Int(bytes[1]) << 8 | Int(bytes[2])
    guard bytes.count == 3 + len + 130,
      let peer = try? P256.KeyAgreement.PublicKey(x963Representation: Data(bytes[(3 + len + 65)...]))
    else { return (65, "input_none_0") }
    let ctx = LAContext()
    ctx.touchIDAuthenticationAllowableReuseDuration = 0
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var err: Error?
    ctx.evaluatePolicy(
      .deviceOwnerAuthenticationWithBiometrics, localizedReason: "turn on Touch ID for AgentLink approvals (test C)"
    ) { s, e in
      ok = s
      err = e
      sem.signal()
    }
    sem.wait()
    if !ok {
      let ns = err as NSError?
      return (ns?.code == -2 || ns?.code == -4 ? 10 : 11, "sheet_la_\(ns?.code ?? 0)")
    }
    do {
      let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
        dataRepresentation: Data(bytes[3..<(3 + len)]), authenticationContext: ctx)
      _ = try key.sharedSecretFromKeyAgreement(with: peer)
      ctx.invalidate()
      return (0, "none")
    } catch {
      ctx.invalidate()
      let ns = error as NSError
      return (13, "verify_\(ns.domain == LAErrorDomain ? "la" : "os")_\(ns.code)")
    }
  }
}

let app = NSApplication.shared
let delegate = Spike()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
