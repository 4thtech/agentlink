# @4thtech-io/ui

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 7e67af9: Design tokens as a typed module and `tokens.css` (four themes, `--al-` prefix), with the Geist and Geist Mono woff2 fonts, the OFL licence and the Lucide ISC notice shipped in the package (M1-35a).
- 037cdf4: Review together (brief B-2): the Waiting for you view with the ApprovalCard batch variant, the Approve, Deny and Later choice and the summary button that names exactly what it applies (M1-35b-b).
- c9cf180: The 31 core components of the design as React components with `components.css` (classes only, no inline styles): approvals, commitments, untrusted content, safety codes, secrets, status, files, credits, shell and tray, with the DESIGN-ADJ-1 fixes (M1-35b).
- c2ef824: M1-35c-b: the package root exports the shipped strings (`en`, `t`, `formatMessage`, the `StringKey` type, `pendingStrings`) and `lintVocabulary`, with the shared `NEVER_SAY` list, `isExemptKey` and `LintOptions`, so page code can lint its copy against 11 §5.1.
- 4173573: The shipped English strings with a small message formatter, a vocabulary lint and key-coverage tests; the 11 section 5.6 disclosure lines, rolling-window wording and the corrected owner-presence copy (M1-35c).

### Patch Changes

- a070208: The app shell status bar can show "Checking…" and "Not connected" (M1-11s-a-b).

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

No changes in this release.
