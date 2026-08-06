import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../lib/logger.ts";

function captureConsole(method) {
  const original = console[method];
  const lines = [];
  console[method] = (line) => lines.push(line);
  return {
    lines,
    restore() { console[method] = original; },
  };
}

test("logger.info never writes the raw email-bearing userId to the log line", () => {
  const capture = captureConsole("info");
  try {
    logger.info("donor_contact_updated", { userId: "user_sgoldstein@nirc.edu", donorId: "donor-1", auditId: "audit-1" });
  } finally {
    capture.restore();
  }
  const line = capture.lines[0];
  assert.ok(line, "logger.info must write exactly one console line");
  assert.doesNotMatch(line, /sgoldstein@nirc\.edu/, "the raw email must never appear in the log line");
  assert.doesNotMatch(line, /@/, "no email-shaped value should appear in the log line at all");
  const parsed = JSON.parse(line);
  assert.match(parsed.userId, /^user_[0-9a-f]{8}$/, "userId must be replaced with a deterministic pseudonym");
  assert.equal(parsed.donorId, "donor-1", "non-identifier fields must pass through unchanged");
  assert.equal(parsed.auditId, "audit-1");
});

test("logger.error sanitizes userId the same way and still reports the error message", () => {
  const capture = captureConsole("error");
  try {
    logger.error("donor_merge_failed", new Error("Database transaction failed"), { userId: "user_sgoldstein@nirc.edu", survivorId: "donor-1" });
  } finally {
    capture.restore();
  }
  const parsed = JSON.parse(capture.lines[0]);
  assert.doesNotMatch(capture.lines[0], /sgoldstein@nirc\.edu/);
  assert.match(parsed.userId, /^user_[0-9a-f]{8}$/);
  assert.equal(parsed.error, "Database transaction failed");
  assert.equal(parsed.survivorId, "donor-1");
});

test("the same userId always pseudonymizes to the same value (correlation preserved)", () => {
  const capture = captureConsole("info");
  try {
    logger.info("event_a", { userId: "user_sgoldstein@nirc.edu" });
    logger.info("event_b", { userId: "user_sgoldstein@nirc.edu" });
  } finally {
    capture.restore();
  }
  const [first, second] = capture.lines.map((line) => JSON.parse(line).userId);
  assert.equal(first, second, "identical userIds must produce identical pseudonyms so log lines can be correlated");
});

test("different userIds pseudonymize to different values", () => {
  const capture = captureConsole("info");
  try {
    logger.info("event", { userId: "user_sgoldstein@nirc.edu" });
    logger.info("event", { userId: "user_someone-else@example.com" });
  } finally {
    capture.restore();
  }
  const [first, second] = capture.lines.map((line) => JSON.parse(line).userId);
  assert.notEqual(first, second);
});

test("log entries without a userId field are unaffected", () => {
  const capture = captureConsole("info");
  try {
    logger.info("migration_history_read", { checkId: "check-1" });
  } finally {
    capture.restore();
  }
  const parsed = JSON.parse(capture.lines[0]);
  assert.equal(parsed.checkId, "check-1");
  assert.ok(!("userId" in parsed));
});

test("a non-string userId is left as-is rather than crashing sanitization", () => {
  const capture = captureConsole("info");
  try {
    logger.info("event", { userId: 12345 });
  } finally {
    capture.restore();
  }
  const parsed = JSON.parse(capture.lines[0]);
  assert.equal(parsed.userId, 12345);
});
