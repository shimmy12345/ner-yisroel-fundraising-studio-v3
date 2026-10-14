import assert from "node:assert/strict";
import { isRealEmailSendAllowed, EmailSendBlockedError } from "../lib/agenda/email-send-guard.ts";

// October 14 2026 email incident (docs/AI-HANDOFF.md) -- the fail-closed
// environment allowlist that stops Staging (or any environment other than
// Independent Production) from ever reaching a real Gmail send, enforced
// at sendGmail()'s own call site regardless of which Worker's scheduled()
// handler called it. Covers every value lib/environment.ts's
// deploymentEnvironment can resolve to today, PLUS values it has never
// resolved to and never should -- this is an ALLOWLIST specifically so
// that an unknown/new/typo'd environment value fails closed by
// construction, not because every bad value happened to be enumerated
// here by hand.

async function run() {
  // --- The one allowed value. ---
  assert.equal(isRealEmailSendAllowed("production-independent"), true, "Independent Production must be allowed to send a real email");

  // --- Every other currently-real deploymentEnvironment value must be
  // blocked -- including legacy "production" (ChatGPT Sites), which is
  // architecturally never reachable from this Worker's scheduled()
  // handler, but must still fail closed rather than rely on that fact. ---
  for (const environment of ["staging-independent", "staging", "production"]) {
    assert.equal(isRealEmailSendAllowed(environment), false, `"${environment}" must never be allowed to send a real email`);
  }

  // --- Unknown/missing/malformed values must also fail closed -- the
  // whole point of an allowlist over a denylist: a value this check has
  // never been taught about defaults to blocked, not to allowed. ---
  for (const environment of ["", "Production-Independent", "production_independent", "PRODUCTION-INDEPENDENT", "undefined", "null", "staging-independent "]) {
    assert.equal(isRealEmailSendAllowed(environment), false, `unrecognized value "${environment}" must fail closed, not open`);
  }

  // --- The thrown error names the actual blocked environment (useful in
  // Observability) and never claims to be anything other than a deliberate
  // block. ---
  const error = new EmailSendBlockedError("staging-independent");
  assert.equal(error.name, "EmailSendBlockedError");
  assert.match(error.message, /staging-independent/);
  assert.match(error.message, /production-independent/);

  console.log("agenda-email-send-guard: all assertions passed");
}

await run();
