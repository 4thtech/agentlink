### Fixed

- First run no longer dead-ends on "This browser can't make a passkey" or on Windows' "Insert your security key" (FIRSTRUN-ANY-PLATFORM, S2, 08 §1, 04 §2.2): on a Mac or Windows computer, in the desktop app or any browser (Firefox too), you create your master code in the app. "Use your master code instead" now makes no passkey request at all. There is no terminal step and no USB key.
- On Windows the setup step says Windows Hello, never Touch ID (FIRSTRUN-ANY-PLATFORM).

### Changed

- After the master code, the desktop app offers Touch ID or Windows Hello for approvals. In a browser, Touch ID or Windows Hello is offered only where the browser says it works here. On Windows the master code comes first, and Windows Hello is the alternative (FIRSTRUN-ANY-PLATFORM, 08 §1).
- "Skip to Home" is hidden until an owner exists, so first run can't end on a Home that doesn't work yet (FIRSTRUN-ANY-PLATFORM).
