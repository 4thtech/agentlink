---
section: Changed
---

- Desktop updates are signed by the release, after the owner's approval click (UPD-0, UPD-3, UPD-KEYTOOL, S2, D-151, 08 §8): one update key, held as a GitHub environment secret and used by one step of `release.yml` only after the approval in `desktop-update`, the same trust as npm `latest`. The release now also attaches the Mac zips, builds the update document from the attested and checked Release files, refuses a build whose pinned key differs from `root-key.json`, checks the signed document with the app's own checks before uploading it, and publishes it as `desktop-update-<key id>.json` and `desktop-update.json`. The app asks for the document of its own key and follows the `stable` channel. A daily check warns 7 days before a document expires. New owner tool `tools/desktop/new-update-key.mjs`; runbook RB-23 rewritten. Updates stay off in release builds until the key is pinned.
