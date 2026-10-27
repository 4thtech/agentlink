---
'@4thtech-io/core': minor
'@4thtech-io/node': minor
---

M1-PAY-CONFIRM-a: confirming paid actions with the computer's own verification (04 §2.5.3, D-132). Core builds the confirmation statement and the challenge from stored data (`buildPayConfirmFlow`, `payConfirmChallenge`, `spendingChanges`) and refuses a paid item in `approval.decideBatch` (`paid_item_in_batch`). The local approval server adds `POST /api/ui/pay-confirm/begin` and `/finish`: user verification required, single use, bound to the page session, 120 s; the backup code keeps the three-tries rule. Approving a paid proof or changing a spending limit through an ordinary owner route now answers `confirm_required`.
