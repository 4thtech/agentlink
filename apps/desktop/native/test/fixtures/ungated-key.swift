// TEST ONLY (WP-D12b): makes a Secure Enclave key WITHOUT a biometry gate and prints it as a
// record v1 (same layout as agentlink-presence `create`). The real helper must refuse it without
// showing a sheet. No keychain item is created; the handle lives only in the test's memory.
import CryptoKit
import Foundation
import Security

let acl = SecAccessControlCreateWithFlags(
  nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage], nil)!
let key = try! SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: acl)
let h = key.dataRepresentation
var out: [UInt8] = [0x01, UInt8(h.count >> 8), UInt8(h.count & 0xff)]
out += h
out += key.publicKey.x963Representation
out += P256.KeyAgreement.PrivateKey().publicKey.x963Representation
let line = out.map { String(format: "%02x", $0) }.joined() + "\n"
FileHandle.standardOutput.write(line.data(using: .utf8)!)
