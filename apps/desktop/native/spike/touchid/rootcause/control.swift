// DESK-TOUCHID-ROOTCAUSE control prompt (owner-local test only; never shipped).
// Run with /usr/bin/swift so the Touch ID sheet belongs to an Apple-signed process (swift-frontend):
// tells apart "the sensor does not feel a finger for our ad-hoc helper" from "no finger reached it".
// No key, no secret. stdout: one fixed token "<stage>_<domain>_<code>" or "none".
import Foundation
import LocalAuthentication

let ctx = LAContext()
var pre: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &pre) else {
  print("sensor_la_\(pre?.code ?? 0)")
  exit(69)
}
let sem = DispatchSemaphore(value: 0)
var code: Int32 = 0
var diag = "none"
ctx.evaluatePolicy(
  .deviceOwnerAuthenticationWithBiometrics, localizedReason: "check that Touch ID works (control test)"
) { ok, err in
  if !ok {
    let ns = err as NSError?
    diag = "sheet_la_\(ns?.code ?? 0)"
    code = 10
  }
  sem.signal()
}
sem.wait()
print(diag)
exit(code)
