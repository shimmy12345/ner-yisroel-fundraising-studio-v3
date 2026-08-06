import assert from "node:assert/strict";
import test from "node:test";
import { resolveIdentity } from "../lib/auth/provider.ts";

const identity = { displayName: "Test User", email: "test@example.com", fullName: "Test User" };

function provider(name, result) {
  return { name, resolve: async () => result };
}

test("returns the first non-null identity in provider order", async () => {
  const resolved = await resolveIdentity([provider("first", null), provider("second", identity), provider("third", { ...identity, email: "unreachable@example.com" })]);
  assert.deepEqual(resolved, identity);
});

test("an earlier provider takes precedence over a later one that would also resolve", async () => {
  const earlier = { ...identity, email: "earlier@example.com" };
  const resolved = await resolveIdentity([provider("first", earlier), provider("second", identity)]);
  assert.deepEqual(resolved, earlier);
});

test("returns null when every provider returns null", async () => {
  const resolved = await resolveIdentity([provider("first", null), provider("second", null)]);
  assert.equal(resolved, null);
});

test("returns null for an empty provider list", async () => {
  const resolved = await resolveIdentity([]);
  assert.equal(resolved, null);
});
