// M2-3a: the cloud-only rows of the Durable Object store (07 §3.1 "Cloud-only rows", D-131; proposed,
// owner confirms at merge). The local schema (core's TABLES) comes from core's shared DDL
// (createSqlSchemaStatements), so it is exactly the Node store's; these tables are the ones the
// local store does not need:
//   deploy_state      one row: the store's schema version, when `/setup` was used (M2-3f-1), the
//                     template version (M2-3i) and the pinned public `/mcp` URL (M2-3c);
//   owner_blobs       the owner's `ALKP` and `ALKR` blobs, opaque to the Worker, written once at
//                     `/setup` (M2-3f-1; 04 §2.2);
//   connector_grants  the owner-signed `connector.authorize` texts, read on every `/mcp` request
//                     (M2-3c; 08 §3.3);
//   agent_items       the cloud form of the agent's keychain items (04 §2.2): `seed` (the agent seed
//                     sealed under SEED_WRAP_KEY on the Deploy-button path, 08 §3.2) and
//                     `policy-version` (the policy-version mark, 04 §2.5.1).
// M2-3a writes deploy_state and agent_items; the other two tables exist for their cards and are
// written by nothing yet. Write-once rules are triggers, so a bug elsewhere cannot overwrite the
// sealed seed or an owner blob.
import { sqlIdent as q } from '@4thtech-io/core';

/** The names of the cloud-only tables, in creation order. */
export const CLOUD_TABLES = [
  'deploy_state',
  'owner_blobs',
  'connector_grants',
  'agent_items',
] as const;
export type CloudTable = (typeof CLOUD_TABLES)[number];

/** The agent items this store may hold (04 §2.2 item names). */
export const AGENT_ITEMS = ['seed', 'policy-version'] as const;
export type AgentItem = (typeof AGENT_ITEMS)[number];

const MAX_INT = Number.MAX_SAFE_INTEGER;
const int = (c: string): string =>
  `typeof(${q(c)}) = 'integer' AND ${q(c)} BETWEEN 0 AND ${MAX_INT}`;
const text = (c: string): string => `typeof(${q(c)}) = 'text' AND length(${q(c)}) > 0`;
const nullable = (c: string, check: string): string => `${q(c)} IS NULL OR (${check})`;

/** The statements that create the cloud-only tables in an empty object (one transaction). */
export function createCloudSchemaStatements(): readonly string[] {
  return Object.freeze([
    `CREATE TABLE "deploy_state" (
  "id" INTEGER NOT NULL CHECK ("id" = 1),
  "schema_version" INTEGER NOT NULL CHECK (${int('schema_version')} AND "schema_version" >= 1),
  "setup_used_at" INTEGER CHECK (${nullable('setup_used_at', int('setup_used_at'))}),
  "template_version" TEXT CHECK (${nullable('template_version', text('template_version'))}),
  "mcp_url" TEXT CHECK (${nullable('mcp_url', text('mcp_url'))}),
  PRIMARY KEY ("id")
) STRICT`,
    `CREATE TABLE "owner_blobs" (
  "kind" TEXT NOT NULL CHECK ("kind" IN ('ALKP', 'ALKR')),
  "blob" TEXT NOT NULL CHECK (${text('blob')}),
  "created_at" INTEGER NOT NULL CHECK (${int('created_at')}),
  PRIMARY KEY ("kind")
) STRICT`,
    `CREATE TRIGGER "owner_blobs__write_once" BEFORE UPDATE ON "owner_blobs" ` +
      `BEGIN SELECT RAISE(ABORT, 'write once'); END`,
    `CREATE TABLE "connector_grants" (
  "grant_id" TEXT NOT NULL CHECK (${text('grant_id')}),
  "client_id" TEXT NOT NULL CHECK (${text('client_id')}),
  "authorize_json" TEXT NOT NULL CHECK (${text('authorize_json')}),
  "revoked_at" INTEGER CHECK (${nullable('revoked_at', int('revoked_at'))}),
  "created_at" INTEGER NOT NULL CHECK (${int('created_at')}),
  PRIMARY KEY ("grant_id")
) STRICT`,
    `CREATE TABLE "agent_items" (
  "name" TEXT NOT NULL CHECK ("name" IN (${AGENT_ITEMS.map((n) => `'${n}'`).join(', ')})),
  "value" TEXT NOT NULL CHECK (${text('value')}),
  PRIMARY KEY ("name")
) STRICT`,
    // The sealed seed is the agent: never replaced and never deleted once stored (04 §2.9).
    `CREATE TRIGGER "agent_items__seed_write_once" BEFORE UPDATE ON "agent_items" ` +
      `WHEN OLD."name" = 'seed' BEGIN SELECT RAISE(ABORT, 'write once'); END`,
    `CREATE TRIGGER "agent_items__seed_kept" BEFORE DELETE ON "agent_items" ` +
      `WHEN OLD."name" = 'seed' BEGIN SELECT RAISE(ABORT, 'permanent'); END`,
  ]);
}
