// DESK-TOUCHID-SPIKE helper variant D (owner-local test only; never bundled in AgentLink).
// Same record v1 as agentlink-presence, but the Touch ID sheet comes from LAContext.evaluatePolicy
// first, and the evaluated context is then handed to the Secure Enclave key (hypothesis b), instead of
// letting the key operation raise its own sheet. Output: nothing on stdout; the secret is wiped.
// stderr: one fixed line "<stage> <domain> <code>". Exit codes as agentlink-presence.
//   argv: ecdh-eval     stdin: record hex
import CryptoKit
import Foundation
import LocalAuthentication

var stage = "args"
func fail(_ code: Int32, _ err: Error? = nil) -> Never {
  var dom = "none"
  var c = 0
  if let ns = err as NSError? {
    dom = ns.domain == LAErrorDomain ? "la" : (ns.domain == NSOSStatusErrorDomain ? "os" : "none")
    c = dom == "none" ? 0 : ns.code
  }
  FileHandle.standardError.write("\(stage) \(dom) \(c)\n".data(using: .utf8)!)
  exit(code)
}

func laExit(_ e: Error) -> Int32 {
  let ns = e as NSError
  guard ns.domain == LAErrorDomain else { return 13 }
  switch ns.code {
  case -2, -4, -9, -3: return 10
  case -1: return 11
  case -1004: return 12
  case -8: return 14
  default: return 13
  }
}

guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == "ecdh-eval" else { fail(64) }
stage = "input"
let raw = FileHandle.standardInput.readDataToEndOfFile()
var hex = String(decoding: raw, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
var bytes = [UInt8]()
var idx = hex.startIndex
while idx < hex.endIndex {
  let next = hex.index(idx, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
  guard let b = UInt8(hex[idx..<next], radix: 16) else { fail(65) }
  bytes.append(b)
  idx = next
}
hex = ""
guard bytes.count > 3, bytes[0] == 1 else { fail(65) }
let len = Int(bytes[1]) << 8 | Int(bytes[2])
guard bytes.count == 3 + len + 130 else { fail(65) }
let handle = Data(bytes[3..<(3 + len)])
guard let peer = try? P256.KeyAgreement.PublicKey(x963Representation: Data(bytes[(3 + len + 65)...]))
else { fail(65) }

stage = "sheet"
let ctx = LAContext()
ctx.touchIDAuthenticationAllowableReuseDuration = 0
let sem = DispatchSemaphore(value: 0)
var evalErr: Error?
var ok = false
ctx.evaluatePolicy(
  .deviceOwnerAuthenticationWithBiometrics,
  localizedReason: "turn on Touch ID for AgentLink approvals (test D)"
) { success, error in
  ok = success
  evalErr = error
  sem.signal()
}
sem.wait()
guard ok else { fail(evalErr.map(laExit) ?? 70, evalErr) }

stage = "verify"
do {
  let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
    dataRepresentation: handle, authenticationContext: ctx)
  let s = try key.sharedSecretFromKeyAgreement(with: peer)
  var n = 0
  s.withUnsafeBytes { n = $0.count }
  ctx.invalidate()
  guard n == 32 else { fail(70) }
  exit(0)
} catch {
  ctx.invalidate()
  fail(laExit(error), error)
}
