---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

The local app's server can now list the files you received and sent (MSG-FILES-IO-d): two read-only routes, `GET /api/ui/files/received` and `GET /api/ui/files/sent`, for the owner's browser session only. Each item shows who, when, the file name, size and state; a received file you saved shows only the single name it was saved under. No file key, link, storage location, hash or folder path is ever returned, nothing is written, and no AI tool changes. Core's `client.filesIo` now reads that saved name; a saved name that cannot be read shows that one file without it instead of hiding the list.
