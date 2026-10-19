// A REAL, local-only D1Database binding for testing D1CalendarStore,
// backed by `getPlatformProxy()` from the `wrangler` npm package --
// Cloudflare's own documented way to get a genuine Workers-runtime D1
// binding (the same Miniflare/workerd runtime `wrangler dev` uses)
// outside of a deployed Worker, for a plain Node test script. This is
// NOT a synchronous SQLite mock standing in for D1 -- it is the real D1
// binding's own query planner, SQLite engine, and error behavior,
// running entirely in-process with no persistence and no remote access.
//
// `persist: false` means every call to createLocalD1Database() gets a
// fresh, empty database with nothing written to disk; `remoteBindings:
// false` means wrangler never attempts to reach any real Cloudflare
// account or remote resource, even if one were misconfigured in
// tests/fixtures/wrangler.calendar-d1-test.jsonc. Together these are what
// make this "local-only, no remote database access" rather than merely
// "local by default."
//
// KNOWN ENVIRONMENT LIMITATION (confirmed 2026-10-18, see
// docs/AI-HANDOFF.md): on this project's Windows development sandbox,
// the bundled workerd.exe binary crashes immediately on invocation
// (Windows structured exception 0xe06d7363) -- getPlatformProxy() hangs
// indefinitely rather than surfacing that failure, because Miniflare
// retries/respawns the crashing child process rather than propagating
// the error. This file itself is platform-agnostic and unchanged by that
// finding; the actual test run therefore happens on an Ubuntu GitHub
// Actions runner (.github/workflows/calendar-d1-adapter-test.yml), where
// the Linux workerd binary is expected to start normally. Nothing here
// attempts to detect or work around the Windows failure -- per this
// round's explicit instruction, no Windows runtime troubleshooting, no
// software installation, continues for this task.
import { getPlatformProxy } from "wrangler";
import fs from "node:fs";
import path from "node:path";

const TEST_WRANGLER_CONFIG_PATH = path.resolve(import.meta.dirname, "../../../tests/fixtures/wrangler.calendar-d1-test.jsonc");
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../drizzle");

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

// D1's own `.exec()` requires one statement per physical line (unlike
// node:sqlite's `.exec()`, which the existing sqlite-backed tests call
// directly on a raw migration file) -- several of this repo's migration
// files contain statements that wrap across multiple lines (e.g. a
// multi-column INSERT's VALUES list), so `.exec()` on the raw file text
// is not reliable here. Every migration file's statements are instead
// split out individually and run one at a time via `.prepare().run()` --
// comment lines (both drizzle-kit's own `--> statement-breakpoint`
// markers and this repo's `--` doc comments) are stripped first, since
// every one of them is a whole-line comment in every migration file this
// was checked against, never a trailing same-line comment after real SQL.
function splitSqlStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type LocalD1Handle = {
  db: D1Database;
  dispose: () => Promise<void>;
};

// Applies every committed drizzle/*.sql migration, in order, against a
// fresh local D1 binding -- the same "read every real migration file and
// exec it in order" convention tests/calendar-sync-sqlite-store.test.mjs
// and tests/calendar-sync-regression-*.test.mjs already use for
// node:sqlite, so the schema under test is provably identical to the one
// those files already prove the reconciler's invariants against.
export async function createLocalD1Database(): Promise<LocalD1Handle> {
  const proxy = await getPlatformProxy({
    configPath: TEST_WRANGLER_CONFIG_PATH,
    persist: false,
    remoteBindings: false,
  });
  const db = proxy.env.DB as unknown as D1Database;
  for (const migration of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migration), "utf8");
    for (const statement of splitSqlStatements(sql)) {
      await db.prepare(statement).run();
    }
  }
  return {
    db,
    dispose: async () => {
      await proxy.dispose();
    },
  };
}
