// UX1113-QA2-ACTIVITY: `GET /api/ui/activity` exactly as the local app served it in a real journey-harness
// run (computer A = Ana, the inviter; B = Bo, who accepted Ana's invite in the app and approved her terms
// on Home; ux1113/integration d220725b, 2026-11-12). Not hand-made. Ana is 0xe653…, Bo is 0x3eee….
export const RECORDED_FEED = {
  "A": {
    "items": [
      {
        "kind": "contact_connected",
        "at": 1794502051,
        "contactId": "0x3eee159d4d95fa782e85670b472739f94692a3b4",
        "via": "your_invite"
      },
      {
        "kind": "rules_changed",
        "at": 1794502046
      },
      {
        "kind": "id_renamed",
        "at": 1794502046,
        "name": "Ana"
      },
      {
        "kind": "id_created",
        "at": 1794502046
      }
    ]
  },
  "B": {
    "items": [
      {
        "kind": "approval_decided",
        "at": 1794502052,
        "decision": "approved",
        "action": "accept_terms",
        "contactId": "0xe653356417386eb9b79fb0224a62cda258883c8e"
      },
      {
        "kind": "contact_connected",
        "at": 1794502051,
        "contactId": "0xe653356417386eb9b79fb0224a62cda258883c8e",
        "via": "their_invite"
      },
      {
        "kind": "approval_decided",
        "at": 1794502051,
        "decision": "approved",
        "action": "accept_invite",
        "contactId": "0xe653356417386eb9b79fb0224a62cda258883c8e"
      },
      {
        "kind": "rules_changed",
        "at": 1794502047
      },
      {
        "kind": "id_renamed",
        "at": 1794502047,
        "name": "Bo"
      },
      {
        "kind": "id_created",
        "at": 1794502047
      }
    ]
  }
} as const;
