# RB-22 · First-run matrix (manual, on real machines)

## Purpose
The owner's acceptance for first run, run by hand on real machines before a release that touches first run, presence (Touch ID, Windows Hello, passkeys), the desktop app's window or the app host. It covers what the automated tests cannot: a real sensor, a real browser, a real OS. Card FIRSTRUN-MATRIX (0.5.5).

**Pass means, on a fresh profile:** create the master code in the app or browser (no passkey dialog on that path) → optionally turn on Touch ID, Windows Hello or a platform passkey → create the ID → connect the AI app → Home. No terminal, no browser hand-off, no USB security key, at any step.

## What is automated (so you need not repeat it)
| Case | Where it runs |
|---|---|
| No platform authenticator: master code, no `navigator.credentials` call, Home | `e2e/test/firstrun-matrix.test.ts` (a, a2), CI job `e2e-deterministic` (Chromium, virtual authenticator) |
| Authenticator without PRF: no dead end, master code finishes | same (b) |
| Authenticator with PRF: one passkey create; Windows: master code first | same (c, c2) |
| Cancelled gesture: "Try again, or use your master code instead", Back works | same (d) |
| "Skip to Home" not shown before an owner exists | same (e) |
| First run with the master code over the host's own calls (no window) | same (f), and `apps/desktop/test/smoke/smoke.mjs` in `desktop.yml` on the built app (macOS, Windows) |
| App record says `host: "desktop"`; window has WebAuthn switched off | smoke (record); `apps/desktop/test/unit/security.test.ts` (window switch) |
| Browser first, then the app takes over by yield: same owner, no setup | `e2e/test/firstrun-continuity.test.ts` |
| App first, then `agentlink ui`: shows the app, no second host | same |

Not automated: a real Touch ID or Windows Hello prompt, Safari, Firefox and Edge (the e2e uses Chromium with CDP's virtual authenticator, which only Chromium has), the Electron window itself (the shell refuses debugging switches), SmartScreen and Gatekeeper.

## Before every row
1. Fresh profile: a new macOS or Windows user, or a machine that never had AgentLink. If it did, quit AgentLink, then remove `~/.agentlink` (Windows: `%USERPROFILE%\.agentlink`), the AgentLink folders, and the keychain / Credential Manager entries named `agentlink` (service `agentlink`, accounts `owner`, `owner-passkey`). Do this only on a test machine; it deletes that machine's AgentLink.
2. Have the AI app you will connect (Claude Desktop or Claude Code) installed, and closed.
3. Note the build (Settings › About) and the date.

## The common path (every row follows it; the row says what differs)
| Step | You do | You see |
|---|---|---|
| 1 | Open AgentLink (the app, or `agentlink ui` in your own terminal for the browser row) | **Which AI app do you use?** with "Step 1 of 5 · Pick your AI app". No "Skip to Home". |
| 2 | Press **Continue with** your AI app | **Confirm it's you**, a field **Name people see** (empty), and the button disabled until you type a name |
| 3 | Type a name (for example `Test`) | The button enables |
| 4 | Press the primary button (see the row) | **Your master code** screen: "Shown once", **Save in my password manager**, **Copy**, **Save as file**, **I saved it** |
| 5 | Copy or save the code, press **I saved it** | **Connected to {app}** (or "{name} is ready" if the app isn't installed). Quit and reopen the AI app if it asks. |
| 6 | Press **Continue** | **Sending and receiving files** ("Step 4 of 5 · Files"): your Send folder (**Allowed**) and Inbox, each with **Show in Finder** (**Show in Explorer** on Windows), and a tip for your AI app. **Continue** or **Skip for now** moves on. |
| 7 | On **Invite someone** press **Done, go to Home** (or **Skip for now**) | Home, with the section menu and a Files panel. No setup screen again. |

The primary button on step 4 is one of: **Continue with a master code** (code path: no sensor dialog at all), or **Connect with Touch ID / Windows Hello / your passkey** (passkey path). Step 2's lead names what you confirm with: "your master code" or the sensor.

## The matrix
Mark each row Pass or Fail, with the build and a note. A Fail needs the screen text you saw.

### A. macOS app
| Row | Machine | Differs from the common path | Expected |
|---|---|---|---|
| A1 | Mac with Touch ID, the app | Step 4: **Continue with a master code**. Then Home shows **Turn on Touch ID** (or Settings › **Touch ID & master code**, switch "Use Touch ID for approvals"). Enter your master code once, touch the sensor. | Code path shows no Touch ID dialog before the code. Afterwards: "Touch ID is on for approvals on this computer." Approving something later asks for Touch ID. |
| A2 | Mac without Touch ID (Mac mini), the app | Step 4: **Continue with a master code**. No Touch ID offer. | No dead end. Settings › master code page says "Touch ID isn't available on this computer, so this asks for your master code." Approvals ask for the master code. |
| A3 | Either Mac: cancel | Row A1, turn on Touch ID, press **Cancel** in the sensor dialog | The page stays usable, shows its own plain line, and the master code still works. |

### B. Windows app (Windows 10 or 11)
| Row | Machine | Differs | Expected |
|---|---|---|---|
| B1 | Windows 11 21H2, Windows Hello PIN set | Install with `AgentLink-win-x64-setup.exe` (SmartScreen: **More info**, **Run anyway**). Step 4: **Continue with a master code**. Then turn on **Windows Hello**. | No "Insert your security key" dialog at any step. Never the word "Touch ID". |
| B2 | Windows 11 21H2, no Hello PIN | Step 4: master code. No Windows Hello offer, or a plain "isn't available" line. | Code path completes; approvals use the master code. |
| B3 | Windows 11 22H2 or newer, Hello PIN set | As B1 | As B1 |
| B4 | Windows 11 22H2 or newer, no Hello PIN | As B2 | As B2 |

### C. Linux, browser
| Row | Machine | Differs | Expected |
|---|---|---|---|
| C1 | Linux desktop, Chrome or Firefox, `agentlink ui` | Step 4: **Continue with a master code** (no platform sensor) | Same as A2 but in the browser. The note "You approve with your master code on this computer. Nothing to install." shows. |

### D. Browsers (the browser app, `agentlink ui` in your own terminal)
Run on a Mac with Touch ID, plus one Windows machine for Edge.
| Row | Browser | Expected on step 2 and 4 |
|---|---|---|
| D1 | Chrome (Mac) | The primary button may be **Connect with Touch ID** (passkey with PRF) with **Use your master code instead** below it. Both finish. A cancelled Touch ID shows "Not protected yet. Try again, or use your master code instead." and the button becomes **Try again**; **Back** returns to step 1. |
| D2 | Safari (Mac) | As D1 |
| D3 | Firefox (Mac or Windows) | Master code is primary (or "A passkey can't be used here. Continue with a master code."). No dead end, no USB-key prompt. |
| D4 | Edge (Windows 11) | Master code first; **Use Windows Hello instead** only when offered. If Windows asks for a security key, that is a Fail. |

### E. Moving between the browser and the app (same computer, same profile)
| Row | Start | Do | Expected |
|---|---|---|---|
| E1 | Browser app, owner created with the master code (row D) | Install and open the AgentLink app | The terminal window of `agentlink ui` says "AgentLink moved to the AgentLink app. Everything is there: your IDs, contacts and AI apps. You can close this window." The app opens on Home with the same ID, contacts and folders; no setup. Approvals in the app ask for the master code, or Touch ID / Windows Hello once turned on. |
| E2 | App with owner created (rows A or B) | In your own terminal run `agentlink ui` | The terminal says "AgentLink is open in the AgentLink app. Its window is in front now." The app window comes forward. No second browser page opens. |
| E3 | App, owner created | Connect another AI app from Settings › AI apps | The app writes its own form of the entry: it works on a computer with no Node installed. |
| E4 | Mac, first time the app asks for the keychain | Open the app on a Mac that used the browser app | The one-time keychain note appears once; **Always Allow** keeps it from asking again. |

### F. Forgot the master code (start over on this computer, D-153)
Use a test machine or a fresh profile with an owner already created (rows A or B). This row deletes nothing, but it moves `~/.agentlink` away and removes AgentLink's own Keychain (Windows: Credential Manager) items, so your AI apps lose their ID.

| Row | Machine | Do | Expected |
|---|---|---|---|
| F1 | Mac with Touch ID, the app | Settings › **Touch ID & master code**, or any master code field: press **Forgot your master code?** Read **Start over on this computer?** (it lists what you lose). Press **Restore from recovery kit** to check it leads to Restore, go **Back**. Press **Start over instead**. In **Type start over** type `start over`; the button reads **Start over with Touch ID**. Press it and touch the sensor. | **You can start fresh**, the line "Your old folder is kept as ~/.agentlink.backup-YYYYMMDD-HHMMSS.", **Quit and reopen your AI apps**, and **Set up AgentLink**. The backup folder exists and nothing in it is deleted. **Set up AgentLink** opens first run (rows A and the common path) with a new master code. |
| F2 | Windows 11 with a Windows Hello PIN, the app | As F1; the button reads **Start over with Windows Hello** | As F1; the Windows Hello prompt opens in front of AgentLink. Credential Manager items named `agentlink` are gone. |
| F3 | Mac without Touch ID, or a PC without Windows Hello, the app | As F1 up to the phrase; the button reads **Continue** | The next screen is **Type start over once more**; type it in **Type start over again** and press **Start over**. No sensor prompt at any point. |
| F4 | A browser (`agentlink ui`) on a computer with a platform sensor | As F1; the page says "Your browser asks you to confirm it's you with Touch ID or Windows Hello." | The browser's own dialog appears; the rest is as F1. Without a sensor, F3's second typing. |
| F5 | Wrong or cancelled | Type `start over` wrongly, or cancel the sensor | "Type start over exactly as shown." or "You closed the prompt. Nothing was changed."; the folder is unchanged. |
| F6 | After F1 | Look at your AI app | It still uses the old ID until you quit and reopen it (the done screen says so). |

It never leaves the person at a dead end, never says "terminal" or "agentlink init", and never changes anything before the phrase and the confirmation. The strings are in `apps/local-ui/src/pages/start-over/strings.ts`.

## Reporting
For a Fail, record: row, OS and version, browser and version (or app version), what you pressed, the exact screen text, and a screenshot. The master code and any link never go into the report. File it under the release's backlog row; do not fix on `main`: follow [RB-21 owner feedback loop](owner-feedback-loop.md).

## Changing this runbook
Each click and screen text above comes from the strings files: `apps/local-ui/src/pages/first-run/strings.ts`, `pages/start/strings.ts`, `pages/start-over/strings.ts`, `presence/strings.ts`, `pages/touch-id/strings.ts` and `apps/cli/src/commands/ui.ts` (`UI_TEXT`). When one of those changes, the e2e tests in `e2e/test/firstrun-matrix.test.ts` read the same files and fail first; then update this page.
