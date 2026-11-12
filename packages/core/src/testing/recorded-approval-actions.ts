// UX1113-QA2-ACTIVITY: approval actions exactly as the approval store held them in a real journey-harness
// run (two temp-HOME computers, `agentlink ui`, real passkey owner actions; ux1113/integration d220725b,
// 2026-11-12), read back through the activity feed's own open-and-parse step. Not hand-made. One value is
// replaced: the accept action's `args.inviteUrl` (a test invite's secret link) is redacted; the feed never
// reads `args`. `expected` is what core's feed made of each action in that run.
// The harness has no proof network, so `agentlink_notarize` approvals cannot be recorded there.
export const RECORDED_APPROVAL_ACTIONS = [
  {
    "expected": {
      "type": "accept_terms",
      "contactId": "0xe653356417386eb9b79fb0224a62cda258883c8e",
      "files": [],
      "feeUsd": null
    },
    "action": {
      "args": {
        "decision": "accept",
        "envelopeId": "-NvVkKxtIgjykxcjZK6Z-Q",
        "notarize": false
      },
      "context": {
        "fee": null,
        "scope": {
          "agentId": "0x3eee159d4d95fa782e85670b472739f94692a3b4",
          "answers": {
            "envelopeHash": "0xcae3ed044d62a967e59674dbb3409ce20284cd02712d1d26665cb7af3d3ecfe6",
            "envelopeId": "-NvVkKxtIgjykxcjZK6Z-Q"
          },
          "counterparty": {
            "agentId": "0xe653356417386eb9b79fb0224a62cda258883c8e",
            "ownerKey": "709c7aa8daaa6760b9012ecb9053e9465a1f662cd8053a6d615df0226345025c"
          },
          "createdAt": 1794502052,
          "decision": "accept",
          "expiresAt": 1795106851,
          "kind": "agentlink/commitment",
          "maxFeeUsd": null,
          "notarize": false,
          "termsHash": "155e5863968110520808fdd1b19772b35f6488bfaaaa7aa18f83bbd4507e4670",
          "termsId": "d_MIw_jqb7K96-frHIGgnQ",
          "thread": "QTndqjaPwuzNv7t04Zlccw",
          "v": 1,
          "version": 1
        },
        "terms": {
          "deadlines": [
            {
              "due": "2027-01-30T17:00:00Z",
              "ref": "d1"
            }
          ],
          "deliverables": [
            {
              "by": "0xe653356417386eb9b79fb0224a62cda258883c8e",
              "description": "Three logo drafts",
              "id": "d1",
              "plaintextSha256": null
            }
          ],
          "parties": [
            "0x3eee159d4d95fa782e85670b472739f94692a3b4",
            "0xe653356417386eb9b79fb0224a62cda258883c8e"
          ],
          "previousTermsHash": null,
          "price": {
            "amount": "500.00",
            "currency": "USD",
            "payer": "0x3eee159d4d95fa782e85670b472739f94692a3b4"
          },
          "subject": "Logo design",
          "termsId": "d_MIw_jqb7K96-frHIGgnQ",
          "validUntil": 1795106851,
          "version": 1
        },
        "triggers": [
          "commitments.accept"
        ]
      },
      "tool": "agentlink_respond_to_terms"
    }
  },
  {
    "expected": {
      "type": "accept_invite",
      "contactId": "0xe653356417386eb9b79fb0224a62cda258883c8e",
      "files": [],
      "feeUsd": null
    },
    "action": {
      "args": {
        "inviteUrl": "https://agentlink.4thtech.io/i#REDACTED-the-recorded-test-invite-link"
      },
      "context": {
        "counterparty": {
          "agentId": "0xe653356417386eb9b79fb0224a62cda258883c8e",
          "ownerKey": "709c7aa8daaa6760b9012ecb9053e9465a1f662cd8053a6d615df0226345025c"
        },
        "inviteId": "qcXnLXXBS9s3i6cmqPD__g",
        "triggers": [
          "contacts.acceptInvites"
        ]
      },
      "tool": "agentlink_accept_invite"
    }
  }
] as const;
