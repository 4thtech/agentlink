---
'@4thtech-io/node': patch
---

FILES-REVEAL (D-152): `POST /api/ui/files/send-folder/reveal` shows the open ID's own pinned Send folder in Finder or Explorer. It takes no input, sits behind the session, CSRF and Origin gate, reads the folder from the verified rules and re-checks it (realpath, not a link, a directory) before opening it with an argv array; fixed `not_found` and `not_opened` answers carry no path.
