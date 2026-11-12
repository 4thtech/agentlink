### Security

- Desktop app (DESK051-C6, S2): every Touch ID or Windows Hello confirmation in the desktop app now answers a fresh, single-use challenge the app's local server issued for exactly that request and page session, as passkey confirmations already do. A copied or replayed confirmation request is refused before any Touch ID sheet appears. Turning the app's own Touch ID on, off or on again with the passkey answers its challenge too.
