// Bounded smoke test, run BEFORE the real D1 adapter test suite in CI
// (.github/workflows/calendar-d1-adapter-test.yml): proves the local
// Workers/D1 runtime (getPlatformProxy(), from the `wrangler` npm
// package) can actually start and serve a real D1 binding on THIS
// runner, before spending time on the full contract/concurrency suite.
// This is exactly the check that could never complete on this project's
// Windows development sandbox (see docs/AI-HANDOFF.md: the bundled
// workerd.exe crashes immediately there, and getPlatformProxy() hangs
// rather than surfacing that failure) -- the GitHub Actions step running
// this script carries its own `timeout-minutes`, which is this script's
// actual hard-timeout/cleanup mechanism: a hang here fails the step and
// kills the whole job rather than hanging a CI run indefinitely.
//
// Exercises the exact primitives D1CalendarStore depends on
// (exec-equivalent schema setup via individual statements, prepare/bind/
// run, batch, and a deliberate UNIQUE violation) against a throwaway
// table -- never calendar_event_links itself, and never any real,
// committed migration -- so a failure here is unambiguously about the
// runtime, not about this feature's own schema or adapter code.
import { createLocalD1Database } from "../../lib/calendar/testing/local-d1.ts";

async function main() {
  console.log("calendar-d1-smoke-test: starting getPlatformProxy()-backed local D1...");
  const { db, dispose } = await createLocalD1Database();
  try {
    console.log("calendar-d1-smoke-test: local D1 binding is up; migrations applied.");

    await db.prepare("CREATE TABLE smoke_test (id TEXT PRIMARY KEY, n INTEGER)").run();
    await db.prepare("INSERT INTO smoke_test (id, n) VALUES (?, ?)").bind("a", 1).run();

    const batchResults = await db.batch([
      db.prepare("UPDATE smoke_test SET n = n + 1 WHERE id = ?").bind("a"),
      db.prepare("SELECT * FROM smoke_test WHERE id = ?").bind("a"),
    ]);
    const updated = batchResults[1].results[0];
    if (updated.n !== 2) throw new Error(`expected n=2 after batch update, got ${JSON.stringify(updated)}`);
    console.log("calendar-d1-smoke-test: prepare/bind/run/batch all work.");

    let sawUniqueViolation = false;
    try {
      await db.prepare("INSERT INTO smoke_test (id, n) VALUES (?, ?)").bind("a", 99).run();
    } catch (error) {
      sawUniqueViolation = true;
      console.log(`calendar-d1-smoke-test: real UNIQUE-violation error message: ${error.message}`);
      if (error.cause) console.log(`calendar-d1-smoke-test: error.cause: ${error.cause.message}`);
    }
    if (!sawUniqueViolation) throw new Error("expected a UNIQUE constraint violation to throw, but the duplicate insert succeeded");

    console.log("calendar-d1-smoke-test: PASSED -- real local D1 runtime confirmed working on this runner.");
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error("calendar-d1-smoke-test: FAILED");
  console.error(error);
  process.exitCode = 1;
});
