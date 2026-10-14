# MANIFEST · D2 (full system and M2 surfaces)

- **Drop:** D2, first pass, received **14 Oct 2026** in the same export as D1 (`agentlink-app-design`). Status: **partial**. Decisions, options shown for 11 §14 and known deviations are shared with [`../d1/MANIFEST.md`](../d1/MANIFEST.md).
- **Claude Design links:** none supplied (see D1).
- **Direction chosen:** "Signal, run in a terminal" (see `../brand/MANIFEST.md`).
- **Brand parts of D2** (OS app icons, tray and menu-bar icons with status variants, PWA and Web Push icons) are delivered in `../brand/icons/`.

## Contents

| Folder | What | Files |
|---|---|---|
| `screens/console/` | Sign in with pairing, home (desktop 1280 and mobile 360), negotiation thread v1→v3 (J8), agents with registration, credits, settings with domain verification | 7 |
| `screens/desktop/`, `desktop-macos/`, `desktop-windows/`, `desktop-linux/` | Tray and menu bar for the 3 OSes with status variants (`desktop/`, not OS-named because one sheet shows all three), first run welcome, AI app auto-setup with config diff, settings with security, updates and About, proof of agreement (macOS), dashboard (Windows light, Linux without tray) | 7 |
| `screens/verify/` | Verify result, valid agreement (light) | 1 |
| `screens/print/` | Printed agreement record, A4 | 1 |
| `screens/invite/`, `accept/` | Invite landing (mobile, light); browser view-and-accept (1280, light) | 2 |
| `screens/onboarding/`, `pay/`, `pricing/` | Connect your AI (waiting); add credits, exchange method (mobile, light); pricing | 3 |
| `screens/cloud/` | Cloud agent setup, sign in as owner (AI app), status | 3 |
| `source/screens/` | The live screens as exported: 46 `*.dc.html`, `support.js` (preview runtime), `index.html` (gallery). The D1 screens are included too. See "Previewing" | 48 |

D2's component specs and reference bundle are in `../d1/components/` (31 components, shared). The folder is about 2.5 MB; every PNG is under 500 KB.

## Partial and missing

Per-item status is in `../README.md`. In short:

- **Delivered (as designs):** owner console (desktop and mobile home), desktop apps for the 3 OSes, cloud agent pages, verify, printed record, invite landing, browser accept, onboarding, pay, pricing, registration and domain verification, J8 negotiation screens, the component library in the shared reference form.
- **Partial:** states and themes (most PNGs are one default state; light only for verify, invite, accept, pay, print and Windows; no US Letter print); console mobile is the home screen only; biometric states are macOS (Touch ID) only, none for Windows Hello; verify shows the valid result only (no failure, altered or not-found states); storage connectors (11 §6.11) appear only on the local Storage screen (Google Drive, Dropbox, OneDrive), with none for the console or desktop; component library lacks standalone specs for negotiation thread, proof-of-agreement summary, printed record, biometric sheet, config diff, OAuth consent card and update banner (they appear only inside screens).
- **Missing:** clickable prototypes J1, J2, J4, J5, J8 (the gallery `index.html` is a static screen index, not a prototype); rationale notes (11 §13); options for 11 §14 Q2, Q6 and Q8.

Placeholders stay as placeholders until the trademark check and the domains are final: `{productName}`, `{consoleHost}`, `{verifyHost}`, `{inviteHost}`, `{payHost}`, `{siteHost}`. Values written `[LIKE THIS]` on screens are for engineering to supply: `[BUILD FINGERPRINT]`, `[RECORD NAME]`, `[VERIFICATION VALUE]` (domain verification), `[CONNECTION PATH]` (cloud agent URL), `[WHAT HAPPENS TO IT]` (payments below the minimum). QR codes are dashed placeholder boxes. The free test-credit amount ($0.50) and the network named in the pay page are proposals (Q5 option A).

## Previewing the live screens

`source/screens/*.dc.html` use a small preview runtime (`support.js`) that mounts the reference components. It is a preview tool only: do not ship it. To open them, an agent serves the folder over HTTP and first restores three things that are **not** committed:

1. `lib/react.production.min.js` and `lib/react-dom.production.min.js` (React 18 UMD builds, MIT; vendored minified third-party code with no provenance in the repo). SHA-256 of the files in the owner's export: `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` (react, 10751 bytes) and `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` (react-dom, 131835 bytes). Fetch from the npm package and compare; never copy unverified.
2. `ds/agentlink/` (a preview copy of the tokens and the reference bundle). Rebuild it from `../d1/tokens/` and `../d1/components/reference/` (`tokens.css`, `fonts/`, `components/bundle.{js,css}`). The preview copy of `tokens.css` in the export is a shorter generated variant; `../d1/tokens/tokens.css` is canonical.
3. Optional: `canvas.json` (screen sizes and canvas pages). Not committed: it embeds the claude.ai link and version of the owner's design-system artifact, which is the owner's to publish.

Further PNG states are rendered from here with a headless browser (`../README.md`, *What to export*).

## Vocabulary check (11 §5.1)

Run at intake over the copy files, the 46 screen sources, component specs and previews. PNGs were not read pixel by pixel; their text comes from the same sources. The design files are **not** edited; the hits are for the owner and the string-externalizing PRs:

| Where | Hit | Verdict |
|---|---|---|
| `screens/Console-agents.dc.html:52` (console, registration explainer) | "bound to your **owner key**" | Never-say term in a default console surface: change, e.g. "bound to you" or "approved with your passkey" |
| `screens/Pay.dc.html:49` | "Advanced · connect a browser **wallet**" | Inside an Advanced disclosure; allowed only if it stays in a top-up method that needs it (§5.1, §6.7). Owner to confirm |
| `screens/Pay.dc.html:39` | "stablecoin such as **USDC**" | Same: allowed inside a top-up method that needs it |
| `screens/Console-credits.dc.html:50` | "Withdraw unused credits to an **address** you control" | Credits › Advanced (Q7 option A): allowed in Advanced only |
| `screens/Local-advanced.dc.html:28,33`, `screens/Cloud-status.dc.html:34` | "Agent ID (address)", "Local address", "Address" | Advanced and status detail: allowed ("Agent ID (Advanced: address)") |
| `copy/strings.en.json` key `chat.status.needs_setup.keychain` | `agentlink init --keystore file` | `keystore` is a command flag in a chat string; §5.1 allows it in terminal output, so keep it only inside the command line |
| `copy/in-chat.md:37`, `screens/Chat-copy.dc.html:47` | "Suggested **relay**: …" | Used in the sense "pass on", not the network. Rename to avoid the never-say word |
| `copy/strings.en.json:104`, `screens/Desktop-settings.dc.html:45,47`, `Banner` spec | "its **signature** didn't match", "Advanced: Signature verified" | Update integrity, not owner approval; the banner text is default UI. Owner to confirm or reword ("couldn't be verified") |
| `design-system/components/specs/EmptyState.md`, `previews/EmptyState.html` | "Send the signed contract to Marko and **notarize** it" | Example of the user's own words in an empty-state prompt; §5.1 allows "notarize" on tight buttons only. Reword to "…and add proof" |
| `copy/in-chat.md:19`, `screens/Chat-copy.dc.html:24`, many previews | file name `contract-signed.pdf`, "signed contract" | Sample file name, not product copy; harmless |
| `in-chat.md:30`, `Chat-copy.dc.html:42` | `envelope="…"` attribute | The fixed untrusted-content wrapper syntax (06 §4); not UI text |
| `Desktop-welcome.dc.html:35`, `Local-states`, `Local-recovery` | "device **password**", "password managers" | OS term and third-party tool name; §5.1 forbids calling *our* codes "password": none do |

No hit for **gas**, **transaction**, **seed phrase**, **mint**, **smart contract**, **on-chain**, **blockchain**, **Nostr**, **decrypt**, **harness**, **faucet**, **unverified**, **legally binding**. "Commitment" appears only in component, icon, token and string-key names and in one sheet label ("Commitment edge cases"); the visible label is "Accepting terms". The brand book and the vocabulary files list the never-say terms by design (`design-system/README.md`, `voice-and-vocabulary.md`).

## Privacy

Nothing private is included: no real personal data, keys or addresses, nothing from docs 01 or 09, no unreleased security details. Sample hosts are `*.example` or `127.0.0.1`; the cloud setup screen uses an example `workers.dev` host with the `[CONNECTION PATH]` placeholder.
