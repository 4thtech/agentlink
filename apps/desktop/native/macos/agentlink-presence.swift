// agentlink-presence (macOS): AgentLink's native owner-presence helper (WP-D12b, phase 2 of
// Decision 3 in the desktop plan). S2: any change needs an independent security review.
//
// WHAT IT DOES
//   A Secure Enclave P-256 key, gated by Touch ID with .biometryCurrentSet, does ECDH with a
//   per-install random peer public key. The 32-byte shared secret is the input keying material the
//   core feeds into HKDF for the ALKH v1 blob (WP-D12a, 04 §2.3.x). The helper never sees the owner
//   seed, a wrapping key or any plaintext; it only returns the ECDH secret after the owner's gesture.
//
// CONTRACT WITH THE CORE (WP-D12a / WP-D12c) — keep in sync with ../windows/agentlink-presence.cpp
//   argv (fixed; anything else exits 64 before any key is touched):
//     available          exit 0 if the Secure Enclave and Touch ID (enrolled) are usable, else 69
//     version            prints "01\n" (record version)
//     create             no gesture; prints a new record (below)
//     check              stdin: record; ECDH with interaction NOT allowed; exit 0 only when the
//                        Secure Enclave refuses with LAError.notInteractive (the key is valid and
//                        needs a gesture); a key that works without a gesture exits 13
//     ecdh <reason-id>   stdin: record; first the same no-gesture proof as `check` (anything but
//                        notInteractive exits without a sheet), then one Touch ID sheet; prints
//                        the 32-byte secret
//   reason-id is one of: setup | approve | pay. The sheet text is fixed here (reasonText below);
//   the caller cannot supply text. macOS shows it as "<app> is trying to <text>".
//
//   stdin: lowercase hex of the record, optionally followed by exactly one "\n"; at most 8192 bytes.
//   stdout: on success only, lowercase hex followed by "\n". Nothing else, ever.
//   stderr: never written. Errors are reported only by the exit code.
//
//   Record v1 (what `create` prints and `check`/`ecdh` read back; the core stores it verbatim
//   next to the ALKH blob — it is not secret, and useless on any other Mac):
//     [0]        0x01                       record version
//     [1..2]     L, u16 big-endian, 1..1024 length of the SE key handle
//     [3..3+L)   SE key handle               CryptoKit dataRepresentation (SE-wrapped, device-bound)
//     next 65    SE public key               X9.63 uncompressed: 0x04 || X || Y
//     next 65    peer public key             X9.63 uncompressed; random per install; its private
//                                            key is discarded inside `create` and never leaves it
//
//   ecdh output: hex of the 32-byte X coordinate of ECDH(SE private key, peer public key), raw
//   (not hashed). Deterministic for the same record across gestures and processes.
//   Suggested ALKH bindings for WP-D12a: credential ID = SHA-256(SE key handle), credential
//   public-key hash = SHA-256(SE public key X9.63), plus the record version (0x01).
//
//   Exit codes (fixed, same numbers on Windows):
//     0 ok · 10 cancelled (Cancel, Use Password, system or app cancel) · 11 failed (not recognised)
//     12 not interactive (incl. the Mac is locked) · 13 key unusable (bad or foreign handle, public key mismatch, key no longer
//     valid e.g. fingers changed, or a key that needs no gesture) · 14 lockout (too many attempts)
//     15 caller refused (phase 3) · 16/17/18 Windows only · 64 usage · 65 bad input · 69 unavailable
//     70 internal error
//
// SECURITY NOTES
//   - No keychain item is created, read or deleted: the key lives in the Secure Enclave and its
//     handle travels with the record. Unregistering = the core forgetting the record.
//   - Phase 2 (unsigned builds) strength equals the WebAuthn PRF path: a same-user process can run
//     this helper and get the secret after the owner's gesture. Phase 3 enables the caller check.
//   - The public key is verified against the handle with interaction NOT allowed, before the
//     interactive context exists, so a malformed or swapped record never shows a sheet.
//
// MANUAL CHECKS (need a finger; Tali). Build: node apps/desktop/build/native.mjs --out /tmp/alp
//   H=/tmp/alp/agentlink-presence; $H create > /tmp/alp/rec
//   1. $H ecdh approve < /tmp/alp/rec  (Touch ID) twice → the same 64 hex chars both times, exit 0
//   2. sheet names AgentLink and says "… is trying to approve this in AgentLink"
//   3. Cancel on the sheet → no output, exit 10 (echo $?); "Use Password…" (if shown) → exit 10
//   4. wrong finger until the sheet gives up → exit 11; repeated until locked → exit 14
//   5. add a fingerprint in System Settings → $H check < /tmp/alp/rec and ecdh exit 13
//   6. ecdh setup / ecdh pay show their own fixed texts. Then: rm -r /tmp/alp (no keychain cleanup).

import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum Exit: Int32 {
  case ok = 0
  case cancelled = 10
  case failed = 11
  case notInteractive = 12
  case keyUnusable = 13
  case lockout = 14
  case callerRefused = 15
  case notHardware = 16
  case attestationRetry = 17
  case weakKey = 18
  case usage = 64
  case badInput = 65
  case unavailable = 69
  case internalError = 70
}

func finish(_ code: Exit) -> Never { exit(code.rawValue) }

// Phase 3 (signed builds): check the parent's code signature (team ID + identifier, via its audit
// token) and refuse anyone else with Exit.callerRefused. Phase 2: unsigned callers have no identity
// to check, so the check is off. Switching it on without an implementation refuses every caller.
let enforceCallerSignature = false
func callerAllowed() -> Bool {
  if !enforceCallerSignature { return true }
  return false
}

func reasonText(_ id: String) -> String? {
  switch id {
  case "setup": return "turn on Touch ID for AgentLink approvals"
  case "approve": return "approve this in AgentLink"
  case "pay": return "confirm this payment in AgentLink"
  default: return nil
  }
}

let recordVersion: UInt8 = 0x01
let maxHandle = 1024
let maxInput = 8192
let pointLen = 65

// MARK: I/O (stdout: hex + "\n" only; stderr: never)

func writeOut(_ bytes: [UInt8]) -> Never {
  let digits: [UInt8] = Array("0123456789abcdef".utf8)
  var buf = [UInt8]()
  buf.reserveCapacity(bytes.count * 2 + 1)
  for b in bytes {
    buf.append(digits[Int(b >> 4)])
    buf.append(digits[Int(b & 0x0f)])
  }
  buf.append(0x0a)
  var off = 0
  while off < buf.count {
    let n = buf[off...].withUnsafeBufferPointer { write(1, $0.baseAddress, $0.count) }
    if n <= 0 {
      if n < 0 && errno == EINTR { continue }
      finish(.internalError)
    }
    off += n
  }
  for i in buf.indices { buf[i] = 0 }
  finish(.ok)
}

func readInput() -> [UInt8] {
  var data = [UInt8]()
  var chunk = [UInt8](repeating: 0, count: 4096)
  while true {
    let n = chunk.withUnsafeMutableBufferPointer { read(0, $0.baseAddress, $0.count) }
    if n < 0 {
      if errno == EINTR { continue }
      finish(.badInput)
    }
    if n == 0 { break }
    data.append(contentsOf: chunk[0..<n])
    if data.count > maxInput { finish(.badInput) }
  }
  if data.last == 0x0a { data.removeLast() }
  guard !data.isEmpty, data.count % 2 == 0 else { finish(.badInput) }
  func nibble(_ c: UInt8) -> UInt8? {
    switch c {
    case 0x30...0x39: return c - 0x30
    case 0x61...0x66: return c - 0x61 + 10
    default: return nil
    }
  }
  var out = [UInt8]()
  out.reserveCapacity(data.count / 2)
  var i = 0
  while i < data.count {
    guard let h = nibble(data[i]), let l = nibble(data[i + 1]) else { finish(.badInput) }
    out.append(h << 4 | l)
    i += 2
  }
  return out
}

struct Record {
  let handle: Data
  let sePub: Data
  let peer: P256.KeyAgreement.PublicKey
}

func parseRecord(_ b: [UInt8]) -> Record {
  guard b.count >= 3, b[0] == recordVersion else { finish(.badInput) }
  let len = Int(b[1]) << 8 | Int(b[2])
  guard len >= 1, len <= maxHandle, b.count == 3 + len + pointLen * 2 else { finish(.badInput) }
  let handle = Data(b[3..<(3 + len)])
  let sePub = Data(b[(3 + len)..<(3 + len + pointLen)])
  let peerBytes = Data(b[(3 + len + pointLen)...])
  guard sePub.first == 0x04, peerBytes.first == 0x04 else { finish(.badInput) }
  guard (try? P256.KeyAgreement.PublicKey(x963Representation: sePub)) != nil else {
    finish(.badInput)
  }
  guard let peer = try? P256.KeyAgreement.PublicKey(x963Representation: peerBytes) else {
    finish(.badInput)
  }
  guard peerBytes != sePub else { finish(.badInput) }
  return Record(handle: handle, sePub: sePub, peer: peer)
}

// MARK: error mapping

func code(for error: Error, keyStage: Bool) -> Exit {
  let ns = error as NSError
  if ns.domain == LAErrorDomain {
    switch ns.code {
    case LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue,
      LAError.userFallback.rawValue:
      return .cancelled
    case LAError.authenticationFailed.rawValue: return .failed
    case LAError.notInteractive.rawValue: return .notInteractive
    case LAError.biometryLockout.rawValue: return .lockout
    case LAError.biometryNotAvailable.rawValue, LAError.biometryNotEnrolled.rawValue,
      LAError.passcodeNotSet.rawValue:
      return .unavailable
    case LAError.invalidContext.rawValue: return .internalError
    default: return .keyUnusable
    }
  }
  // Mac locked (errSecInteractionNotAllowed): nothing can be asked now.
  if ns.domain == NSOSStatusErrorDomain && ns.code == Int(errSecInteractionNotAllowed) {
    return .notInteractive
  }
  if error is CryptoKitError || keyStage { return .keyUnusable }
  return .internalError
}

/// Opens the handle with interaction NOT allowed and checks it matches the stored public key.
func verifiedKey(_ rec: Record) -> SecureEnclave.P256.KeyAgreement.PrivateKey {
  let quiet = LAContext()
  quiet.interactionNotAllowed = true
  let key: SecureEnclave.P256.KeyAgreement.PrivateKey
  do {
    key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: rec.handle, authenticationContext: quiet)
  } catch {
    finish(code(for: error, keyStage: true))
  }
  guard key.publicKey.x963Representation == rec.sePub else { finish(.keyUnusable) }
  return key
}

func rawSecret(_ s: SharedSecret) -> [UInt8] { s.withUnsafeBytes { Array($0) } }

// MARK: commands

func cmdAvailable() -> Never {
  guard SecureEnclave.isAvailable else { finish(.unavailable) }
  var err: NSError?
  guard LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
    finish(.unavailable)
  }
  finish(.ok)
}

func cmdCreate() -> Never {
  guard SecureEnclave.isAvailable else { finish(.unavailable) }
  var err: NSError?
  guard LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
    finish(.unavailable)
  }
  var cfErr: Unmanaged<CFError>?
  guard
    let acl = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet],
      &cfErr)
  else {
    cfErr?.release()
    finish(.internalError)
  }
  let key: SecureEnclave.P256.KeyAgreement.PrivateKey
  do {
    key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: acl)
  } catch {
    finish(code(for: error, keyStage: false))
  }
  let handle = key.dataRepresentation
  guard handle.count >= 1, handle.count <= maxHandle else { finish(.internalError) }
  // Per-install random peer key: only its public half is kept.
  let peerPub = P256.KeyAgreement.PrivateKey().publicKey.x963Representation
  let sePub = key.publicKey.x963Representation
  guard sePub.count == pointLen, peerPub.count == pointLen, sePub != peerPub else {
    finish(.internalError)
  }
  var out: [UInt8] = [recordVersion, UInt8(handle.count >> 8), UInt8(handle.count & 0xff)]
  out += handle
  out += sePub
  out += peerPub
  writeOut(out)
}

/// Proves the key needs a gesture: an ECDH attempt with interaction NOT allowed must be refused
/// with LAError.notInteractive. A key that works without a gesture (not made by `create`) or fails
/// any other way is never used for the real exchange.
func requireGated(_ key: SecureEnclave.P256.KeyAgreement.PrivateKey, _ peer: P256.KeyAgreement.PublicKey) {
  do {
    var s = rawSecret(try key.sharedSecretFromKeyAgreement(with: peer))
    for i in s.indices { s[i] = 0 }
    finish(.keyUnusable)
  } catch {
    // Only the LocalAuthentication refusal proves the gate (a locked Mac's OSStatus does not).
    let ns = error as NSError
    if ns.domain == LAErrorDomain && ns.code == LAError.notInteractive.rawValue { return }
    finish(code(for: error, keyStage: true))
  }
}

func cmdCheck() -> Never {
  let rec = parseRecord(readInput())
  requireGated(verifiedKey(rec), rec.peer)
  finish(.ok)
}

func cmdEcdh(_ reason: String) -> Never {
  let rec = parseRecord(readInput())
  requireGated(verifiedKey(rec), rec.peer)
  let ctx = LAContext()
  ctx.localizedReason = reason
  ctx.touchIDAuthenticationAllowableReuseDuration = 0
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
      dataRepresentation: rec.handle, authenticationContext: ctx)
    guard key.publicKey.x963Representation == rec.sePub else { finish(.keyUnusable) }
    let s = rawSecret(try key.sharedSecretFromKeyAgreement(with: rec.peer))
    ctx.invalidate()
    guard s.count == 32 else { finish(.internalError) }
    writeOut(s)
  } catch {
    ctx.invalidate()
    finish(code(for: error, keyStage: true))
  }
}

// MARK: main

signal(SIGPIPE, SIG_IGN)
let argv = CommandLine.arguments
guard callerAllowed() else { finish(.callerRefused) }
switch (argv.count, argv.count > 1 ? argv[1] : "") {
case (2, "available"): cmdAvailable()
case (2, "version"): writeOut([recordVersion])
case (2, "create"): cmdCreate()
case (2, "check"): cmdCheck()
case (3, "ecdh"):
  guard let reason = reasonText(argv[2]) else { finish(.usage) }
  cmdEcdh(reason)
default: finish(.usage)
}
