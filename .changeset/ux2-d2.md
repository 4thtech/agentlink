---
'@4thtech-io/local-ui': patch
---

UX2-d2: Contacts gets an Add contact button and side sheet (b11 §21). Invite someone creates an invite without Touch ID and hands it on through Copy invite, the system share sheet (only where the browser has one) or a QR code; the invite shows only in the sheet and never in an element attribute, the address, the title, a toast or a log. I have an invite checks a pasted invite first and asks "Is this who you expected?" with the name, label and short owner fingerprint before Connect asks for Touch ID. Home's contact step opens the sheet; the shared QR code no longer mirrors its value into `data-value` unless asked (Add credits still does).
