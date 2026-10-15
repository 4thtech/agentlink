---
'@agentlink/core': minor
---

Route `contact.check` through the owner-action module (M1-7d with M1-7c-b, IR-M1-7c-b-1 F02, F03). `client.ownerActions.apply` now applies a `contact.check` through `contacts.applyContactCheck` instead of refusing it with `unsupported_op`: the same object checks in the 04 §2.5.1 order, the nonce before the op's rule, and the same fixed refusal codes, which `OwnerActionRefusal` now includes (`contact_unknown`, `pairing_unavailable`). A revoked own agent refuses a `contact.check` with `identity_revoked`, on both paths. The `OwnerActions` constructor takes the `ContactBook` (`new OwnerActions(ctx, identity, contacts, mark?)`). One shared read of the own stored card replaces the copies in `IdentityService` and `ContactBook`. No behaviour change for the other ops.
