### Added

- Message network view, back end (NET-PROBE, NET-STATS, NET-ROUTE, S1, D-157, 07 §3.2 and §4.3, 08 §1): the app can check each of your message-network servers from this computer while Advanced › Message network is open (connect time, round trip, sign-in and payment flags), keeps per-server counters for the last day (store version 23, counters only, your own and the old read-only servers only), and serves them at `GET /api/ui/network` with a `network` live event. Server hosts appear under the hood only; contacts' hosts only when you expand them. Nothing changes for anyone who never opens Under the hood.

### Changed

- Your own message-network server list now holds 2 to 8 servers (D-157 (2), 07 §4.3): a new or changed list outside that is refused, and the contact-details update keeps the first 8 of your own entries (Under the hood says how many it would leave out) and fills up to 8. Contacts' lists keep their limit of 16.
