---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

M2-3a: the SQLite DDL of the logical store schema moved unchanged from `@4thtech-io/node` (`sqlite-schema.ts`) to `@4thtech-io/core` (`store/sql-schema.ts`, exported as `createSqlSchemaStatements` and its helpers), so the cloud agent's Durable Object store runs exactly the Node store's statements. The Node store re-exports them under their earlier names; its pinned statement digests are unchanged. No behaviour change.
