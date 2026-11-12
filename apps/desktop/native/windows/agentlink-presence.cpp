// agentlink-presence.exe (Windows): AgentLink's native owner-presence helper (WP-D12b, phase 2 of
// Decision 3 in the desktop plan). S2: any change needs an independent security review.
// Built by apps/desktop/build/native.mjs with MSVC (C++20, C++/WinRT from the Windows SDK, static CRT).
//
// WHAT IT DOES
//   A Windows Hello KeyCredential (RSA 2048, held by the TPM; software keys are refused at create)
//   signs a per-install random 32-byte challenge with RSASSA-PKCS1-v1_5 / SHA-256. That padding is
//   deterministic, so the signature is the same on every gesture: it is the input keying material
//   the core feeds into HKDF for the ALKH v1 blob (WP-D12a, 04 §2.3.x). The helper verifies every
//   signature as PKCS#1 v1.5 SHA-256 under the stored public key before printing it, so a different
//   padding (which would not be deterministic) can never reach the core.
//
// CONTRACT WITH THE CORE (WP-D12a / WP-D12c) — keep in sync with ../macos/agentlink-presence.swift
//   argv (fixed; anything else exits 64 before any key is touched):
//     available          exit 0 if Windows Hello is set up (KeyCredentialManager.IsSupportedAsync)
//     version            prints "01\n" (record version)
//     create             Windows Hello prompt(s); makes a new credential, requires TPM attestation,
//                        signs the new challenge once (so registration needs no separate sign), and
//                        prints record || u16 BE sig length || signature (below); on any refusal
//                        the new credential is deleted and nothing is printed
//     check              stdin: record; no prompt; exit 0 if the credential exists and its public
//                        key matches the record, else 13
//     sign <reason-id>   stdin: record; one Windows Hello prompt; prints the signature
//     delete             stdin: record; removes the credential (no prompt); exit 0 or 13
//   reason-id is one of: setup | approve | pay. Windows Hello draws its own fixed text and takes no
//   caller text; the id is accepted for symmetry with macOS and otherwise unused.
//
//   stdin: lowercase hex of the record, optionally followed by exactly one "\n"; at most 8192 bytes.
//   stdout: on success only, lowercase hex followed by "\n". Nothing else, ever.
//   stderr: never written. Errors are reported only by the exit code.
//
//   Record v1 (what `create` prints and the other commands read back; not secret). The core does
//   not store it: it reads it into the ALKH header fields and rebuilds it from the stored header for
//   every later call (04 §2.3.4 "Helper record"; DESK-D12c):
//     [0]        0x01                         record version
//     [1]        N, 1..64                     length of the credential name
//     [2..2+N)   credential name, ASCII       "AgentLink-owner-" + 32 lowercase hex (random)
//     next 2     S, u16 big-endian, 1..2048   length of the public key
//     next S     public key                   X.509 SubjectPublicKeyInfo DER (RSA)
//     next 32    challenge                    random per install
//
//   create output: hex of (record v1 || u16 big-endian L || L-byte signature over the challenge).
//   The record is self-delimiting; the core keeps it in memory until the seal (it stores only the
//   ALKH blob) and uses the signature once, as the first secret (readNativeCreateOutput).
//   sign output: hex of the RSASSA-PKCS1-v1_5 SHA-256 signature over the challenge (256 bytes for
//   RSA 2048). The ALKH binding (HKDF info) is in 04 §2.3.4: version, kind, credential ID,
//   SHA-256 of the credential public key, SHA-256 of the challenge, owner key.
//
//   Exit codes (fixed, same numbers on macOS):
//     0 ok · 10 cancelled (incl. "use password") · 11 failed · 12 not interactive (macOS only)
//     13 key unusable (credential missing, public key mismatch, signature does not verify)
//     14 lockout (security device locked) · 15 caller refused (phase 3)
//     16 not hardware (attestation NotSupported: a software key, or UnknownError; refused)
//     17 attestation not available yet (TemporaryFailure; the new credential is deleted, retry later)
//     18 weak key (RSA modulus under 2048 bits; refused)
//     64 usage · 65 bad input · 69 unavailable (no Windows Hello) · 70 internal error
//
// SECURITY NOTES
//   - Phase 2 (unsigned builds) strength equals the WebAuthn PRF path: a same-user process can run
//     this helper and get the signature after the owner's gesture. Phase 3 enables the caller check.
//   - Attestation Success is a LOCAL HEURISTIC only: the status and buffers come from the OS on
//     this machine, and the certificate chain is not validated against a TPM vendor root here or by
//     any 4thTech service. It keeps honest software-only Hello keys out; it proves nothing to a
//     remote party and does not stop a same-user process that already controls this helper.
//   - Refusals at create (16, 17, 18) are not dead ends: approvals keep working with the backup
//     code (master/owner code), and 17 may be retried later. The core shows that fallback.
//
// MANUAL CHECKS (need Windows Hello; Tali, on a TPM machine and on a VM without TPM):
//   create -> record + signature printed; count the Hello prompts (goal: one);
//   sign approve -> same signature as the one create printed; sign approve twice -> identical signature; Cancel -> 10;
//   VM without TPM / software Hello -> create exits 16 and no credential stays behind;
//   delete -> check exits 13; note whether the Hello dialog opens in front of the AgentLink window.

#include <windows.h>
#include <bcrypt.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Security.Cryptography.Core.h>
#include <winrt/Windows.Storage.Streams.h>

#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Security::Credentials;
using namespace winrt::Windows::Security::Cryptography;
using namespace winrt::Windows::Security::Cryptography::Core;
using winrt::Windows::Storage::Streams::IBuffer;

constexpr int EXIT_OK = 0;
constexpr int EXIT_CANCELLED = 10;
constexpr int EXIT_FAILED = 11;
constexpr int EXIT_NOT_INTERACTIVE = 12;
constexpr int EXIT_KEY_UNUSABLE = 13;
constexpr int EXIT_LOCKOUT = 14;
constexpr int EXIT_CALLER_REFUSED = 15;
constexpr int EXIT_NOT_HARDWARE = 16;
constexpr int EXIT_ATTESTATION_RETRY = 17;
constexpr int EXIT_WEAK_KEY = 18;
constexpr int EXIT_USAGE = 64;
constexpr int EXIT_BAD_INPUT = 65;
constexpr int EXIT_UNAVAILABLE = 69;
constexpr int EXIT_INTERNAL_ERROR = 70;

constexpr std::uint8_t kRecordVersion = 0x01;
constexpr size_t kMaxInput = 8192;
constexpr size_t kChallengeLen = 32;
constexpr size_t kMaxName = 64;
constexpr size_t kMaxSpki = 2048;
constexpr std::uint32_t kMinRsaBits = 2048;
constexpr wchar_t kNamePrefix[] = L"AgentLink-owner-";

// Phase 3 (signed builds): check the parent's Authenticode signature (publisher + file) and refuse
// anyone else with EXIT_CALLER_REFUSED. Phase 2: unsigned callers have no identity to check, so the
// check is off. Switching it on without an implementation refuses every caller.
constexpr bool kEnforceCallerSignature = false;
static bool CallerAllowed() {
  if (!kEnforceCallerSignature) return true;
  return false;
}

[[noreturn]] static void Finish(int code) { ExitProcess(static_cast<UINT>(code)); }

static bool IsReason(const wchar_t* id) {
  for (const wchar_t* r : {L"setup", L"approve", L"pay"}) {
    if (wcscmp(id, r) == 0) return true;
  }
  return false;
}

// ---- I/O (stdout: hex + "\n" only; stderr: never) ----

[[noreturn]] static void WriteOut(std::vector<std::uint8_t> bytes) {
  static const char digits[] = "0123456789abcdef";
  std::string buf;
  buf.reserve(bytes.size() * 2 + 1);
  for (std::uint8_t b : bytes) {
    buf.push_back(digits[b >> 4]);
    buf.push_back(digits[b & 0x0f]);
  }
  buf.push_back('\n');
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  size_t off = 0;
  while (off < buf.size()) {
    DWORD n = 0;
    if (!WriteFile(out, buf.data() + off, static_cast<DWORD>(buf.size() - off), &n, nullptr) || n == 0) {
      Finish(EXIT_INTERNAL_ERROR);
    }
    off += n;
  }
  SecureZeroMemory(buf.data(), buf.size());
  SecureZeroMemory(bytes.data(), bytes.size());
  Finish(EXIT_OK);
}

static std::vector<std::uint8_t> ReadInput() {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<std::uint8_t> data;
  std::uint8_t chunk[4096];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(in, chunk, sizeof chunk, &n, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      Finish(EXIT_BAD_INPUT);
    }
    if (n == 0) break;
    data.insert(data.end(), chunk, chunk + n);
    if (data.size() > kMaxInput) Finish(EXIT_BAD_INPUT);
  }
  if (!data.empty() && data.back() == '\n') data.pop_back();
  if (data.empty() || data.size() % 2 != 0) Finish(EXIT_BAD_INPUT);
  auto nibble = [](std::uint8_t c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  std::vector<std::uint8_t> out;
  out.reserve(data.size() / 2);
  for (size_t i = 0; i < data.size(); i += 2) {
    int h = nibble(data[i]), l = nibble(data[i + 1]);
    if (h < 0 || l < 0) Finish(EXIT_BAD_INPUT);
    out.push_back(static_cast<std::uint8_t>(h << 4 | l));
  }
  return out;
}

struct Record {
  std::wstring name;
  std::vector<std::uint8_t> spki;
  std::vector<std::uint8_t> challenge;
};

static bool ValidName(const std::wstring& name) {
  const size_t prefix = wcslen(kNamePrefix);
  if (name.size() != prefix + 32 || name.compare(0, prefix, kNamePrefix) != 0) return false;
  for (size_t i = prefix; i < name.size(); i++) {
    wchar_t c = name[i];
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
  }
  return true;
}

static Record ParseRecord(const std::vector<std::uint8_t>& b) {
  if (b.size() < 2 || b[0] != kRecordVersion) Finish(EXIT_BAD_INPUT);
  const size_t n = b[1];
  if (n < 1 || n > kMaxName || b.size() < 2 + n + 2) Finish(EXIT_BAD_INPUT);
  Record r;
  for (size_t i = 0; i < n; i++) r.name.push_back(static_cast<wchar_t>(b[2 + i]));
  if (!ValidName(r.name)) Finish(EXIT_BAD_INPUT);
  const size_t s = static_cast<size_t>(b[2 + n]) << 8 | b[3 + n];
  if (s < 1 || s > kMaxSpki || b.size() != 4 + n + s + kChallengeLen) Finish(EXIT_BAD_INPUT);
  r.spki.assign(b.begin() + 4 + n, b.begin() + 4 + n + s);
  r.challenge.assign(b.begin() + 4 + n + s, b.end());
  return r;
}

// ---- WinRT helpers ----

static IBuffer ToBuffer(const std::vector<std::uint8_t>& v) {
  return CryptographicBuffer::CreateFromByteArray(array_view<std::uint8_t const>(v));
}

static std::vector<std::uint8_t> FromBuffer(const IBuffer& buf) {
  com_array<std::uint8_t> a;
  CryptographicBuffer::CopyToByteArray(buf, a);
  return std::vector<std::uint8_t>(a.begin(), a.end());
}

static void Random(std::uint8_t* p, size_t n) {
  if (BCryptGenRandom(nullptr, p, static_cast<ULONG>(n), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    Finish(EXIT_INTERNAL_ERROR);
  }
}

static int MapStatus(KeyCredentialStatus s) {
  switch (s) {
    case KeyCredentialStatus::Success: return EXIT_OK;
    case KeyCredentialStatus::UserCanceled:
    case KeyCredentialStatus::UserPrefersPassword: return EXIT_CANCELLED;
    case KeyCredentialStatus::NotFound: return EXIT_KEY_UNUSABLE;
    case KeyCredentialStatus::SecurityDeviceLocked: return EXIT_LOCKOUT;
    case KeyCredentialStatus::CredentialAlreadyExists: return EXIT_INTERNAL_ERROR;
    default: return EXIT_FAILED;
  }
}

// Imports the SPKI as an RSA PKCS#1 v1.5 SHA-256 verification key; nothing else is accepted.
static CryptographicKey VerifyKey(const std::vector<std::uint8_t>& spki) {
  auto alg = AsymmetricKeyAlgorithmProvider::OpenAlgorithm(AsymmetricAlgorithmNames::RsaSignPkcs1Sha256());
  auto key = alg.ImportPublicKey(ToBuffer(spki), CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo);
  if (key.KeySize() < kMinRsaBits) Finish(EXIT_WEAK_KEY);
  return key;
}

static KeyCredential OpenMatching(const Record& r) {
  auto res = KeyCredentialManager::OpenAsync(hstring(r.name)).get();
  if (res.Status() != KeyCredentialStatus::Success) Finish(MapStatus(res.Status()));
  auto cred = res.Credential();
  auto pub = FromBuffer(cred.RetrievePublicKey(CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo));
  if (pub != r.spki) Finish(EXIT_KEY_UNUSABLE);
  return cred;
}

// ---- commands ----

// Deletes a credential made by this run of `create`, then exits with code.
[[noreturn]] static void Refuse(const std::wstring& name, int code) {
  try {
    KeyCredentialManager::DeleteAsync(hstring(name)).get();
  } catch (...) {
  }
  Finish(code);
}

[[noreturn]] static void CmdAvailable() {
  Finish(KeyCredentialManager::IsSupportedAsync().get() ? EXIT_OK : EXIT_UNAVAILABLE);
}

[[noreturn]] static void CmdCreate() {
  if (!KeyCredentialManager::IsSupportedAsync().get()) Finish(EXIT_UNAVAILABLE);
  std::uint8_t id[16];
  Random(id, sizeof id);
  std::wstring name = kNamePrefix;
  static const wchar_t hexd[] = L"0123456789abcdef";
  for (std::uint8_t b : id) {
    name.push_back(hexd[b >> 4]);
    name.push_back(hexd[b & 0x0f]);
  }
  std::vector<std::uint8_t> challenge(kChallengeLen);
  Random(challenge.data(), challenge.size());

  auto res = KeyCredentialManager::RequestCreateAsync(hstring(name), KeyCredentialCreationOption::FailIfExists).get();
  if (res.Status() != KeyCredentialStatus::Success) Finish(MapStatus(res.Status()));
  auto cred = res.Credential();

  // From here on, any refusal deletes the new credential so no unusable key stays behind.
  try {
    auto att = cred.GetAttestationAsync().get();
    const auto status = att.Status();
    // Local heuristic only (see SECURITY NOTES): the OS's own answer, chain not validated.
    if (status == KeyCredentialAttestationStatus::TemporaryFailure) Refuse(name, EXIT_ATTESTATION_RETRY);
    // NotSupported (software key) or UnknownError: fail closed.
    if (status != KeyCredentialAttestationStatus::Success) Refuse(name, EXIT_NOT_HARDWARE);
    if (!att.AttestationBuffer() || att.AttestationBuffer().Length() == 0 || !att.CertificateChainBuffer() ||
        att.CertificateChainBuffer().Length() == 0) {
      Refuse(name, EXIT_NOT_HARDWARE);
    }
    auto spki = FromBuffer(cred.RetrievePublicKey(CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo));
    if (spki.empty() || spki.size() > kMaxSpki) Refuse(name, EXIT_INTERNAL_ERROR);
    auto alg = AsymmetricKeyAlgorithmProvider::OpenAlgorithm(AsymmetricAlgorithmNames::RsaSignPkcs1Sha256());
    auto key = alg.ImportPublicKey(ToBuffer(spki), CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo);
    if (key.KeySize() < kMinRsaBits) Refuse(name, EXIT_WEAK_KEY);

    // First signature now, so registration needs no separate `sign setup` (and,
    // where Windows reuses the create gesture, no second prompt). Same fixed-padding check as `sign`.
    auto data = ToBuffer(challenge);
    auto sr = cred.RequestSignAsync(data).get();
    if (sr.Status() != KeyCredentialStatus::Success) Refuse(name, MapStatus(sr.Status()));
    if (!CryptographicEngine::VerifySignature(key, data, sr.Result())) Refuse(name, EXIT_KEY_UNUSABLE);
    auto sig = FromBuffer(sr.Result());
    if (sig.empty() || sig.size() > 0xffff) Refuse(name, EXIT_INTERNAL_ERROR);

    std::vector<std::uint8_t> out;
    out.push_back(kRecordVersion);
    out.push_back(static_cast<std::uint8_t>(name.size()));
    for (wchar_t c : name) out.push_back(static_cast<std::uint8_t>(c));
    out.push_back(static_cast<std::uint8_t>(spki.size() >> 8));
    out.push_back(static_cast<std::uint8_t>(spki.size() & 0xff));
    out.insert(out.end(), spki.begin(), spki.end());
    out.insert(out.end(), challenge.begin(), challenge.end());
    out.push_back(static_cast<std::uint8_t>(sig.size() >> 8));
    out.push_back(static_cast<std::uint8_t>(sig.size() & 0xff));
    out.insert(out.end(), sig.begin(), sig.end());
    SecureZeroMemory(sig.data(), sig.size());
    WriteOut(std::move(out));
  } catch (...) {
    Refuse(name, EXIT_INTERNAL_ERROR);
  }
}

[[noreturn]] static void CmdCheck() {
  Record r = ParseRecord(ReadInput());
  OpenMatching(r);
  Finish(EXIT_OK);
}

[[noreturn]] static void CmdSign() {
  Record r = ParseRecord(ReadInput());
  auto verifyKey = VerifyKey(r.spki);
  auto cred = OpenMatching(r);
  auto data = ToBuffer(r.challenge);
  auto res = cred.RequestSignAsync(data).get();
  if (res.Status() != KeyCredentialStatus::Success) Finish(MapStatus(res.Status()));
  auto sig = res.Result();
  // Fixed padding: only a valid RSASSA-PKCS1-v1_5 SHA-256 signature leaves the helper.
  if (!CryptographicEngine::VerifySignature(verifyKey, data, sig)) Finish(EXIT_KEY_UNUSABLE);
  WriteOut(FromBuffer(sig));
}

[[noreturn]] static void CmdDelete() {
  Record r = ParseRecord(ReadInput());
  OpenMatching(r);
  KeyCredentialManager::DeleteAsync(hstring(r.name)).get();
  Finish(EXIT_OK);
}

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
  if (!CallerAllowed()) Finish(EXIT_CALLER_REFUSED);
  try {
    init_apartment(apartment_type::multi_threaded);
    if (argc == 2 && wcscmp(argv[1], L"available") == 0) CmdAvailable();
    if (argc == 2 && wcscmp(argv[1], L"version") == 0) WriteOut({kRecordVersion});
    if (argc == 2 && wcscmp(argv[1], L"create") == 0) CmdCreate();
    if (argc == 2 && wcscmp(argv[1], L"check") == 0) CmdCheck();
    if (argc == 2 && wcscmp(argv[1], L"delete") == 0) CmdDelete();
    if (argc == 3 && wcscmp(argv[1], L"sign") == 0) {
      if (!IsReason(argv[2])) Finish(EXIT_USAGE);
      CmdSign();
    }
    Finish(EXIT_USAGE);
  } catch (const hresult_error& e) {
    // Credential gone or key unusable surfaces as NTE_* / NOT_FOUND; anything else is internal.
    const int32_t hr = e.code();
    if (hr == static_cast<int32_t>(NTE_BAD_KEYSET) || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
      Finish(EXIT_KEY_UNUSABLE);
    }
    if (hr == static_cast<int32_t>(NTE_BAD_DATA) || hr == E_INVALIDARG) Finish(EXIT_BAD_INPUT);
    Finish(EXIT_INTERNAL_ERROR);
  } catch (...) {
    Finish(EXIT_INTERNAL_ERROR);
  }
  // Every path above ends in Finish (ExitProcess); no return, so /W4 /WX sees no unreachable code.
}
