// Builds a store file of an earlier schema version for the migration tests. Not part of the build
// (tsconfig.json excludes *.fixture.ts).
import type Database from 'better-sqlite3';
import { MIGRATIONS } from './sqlite-schema.js';

/**
 * Runs the statements of the first `count` migrations on `raw`, as the store had them at that
 * version. Pragmas (application_id, user_version) and rows stay with the caller.
 *
 * One transaction for all of them: run one by one, each statement commits on its own, and on
 * Windows runners about 80 commits (a rollback journal created, synced and deleted each time) took
 * longer than the test timeout. The schema built is the same.
 */
export function replayMigrations(raw: Database.Database, count: number): void {
  raw.transaction(() => {
    for (const m of MIGRATIONS.slice(0, count)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
  })();
}
