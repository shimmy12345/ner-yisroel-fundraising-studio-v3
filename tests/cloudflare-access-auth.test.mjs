import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { verifyAccessToken } from "../lib/auth/cloudflare-access.ts";

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const POLICY_AUD = "test-policy-aud";

async function keyPair() {
  return generateKeyPair("RS256");
}

async function jwksFor(publicKey) {
  const jwk = await exportJWK(publicKey);
  return createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
}

async function signToken(privateKey, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "sgoldstein@nirc.edu", ...overrides.claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 3600)
    .setIssuer(overrides.issuer ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.audience ?? POLICY_AUD)
    .sign(privateKey);
}

test("valid token with matching issuer and audience returns the verified email", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey);
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.deepEqual(identity, { email: "sgoldstein@nirc.edu" });
});

test("valid token with a matching owner restriction (case-insensitive) returns the identity", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey);
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "SGoldstein@Nirc.edu" }, jwks);
  assert.deepEqual(identity, { email: "sgoldstein@nirc.edu" });
});

test("valid token whose email does not match the owner restriction is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey, { claims: { email: "someone-else@example.com" } });
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu" }, jwks);
  assert.equal(identity, null);
});

test("missing token is rejected", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const identity = await verifyAccessToken(null, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("malformed token is rejected", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const identity = await verifyAccessToken("not-a-real-jwt", { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("expired token is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(privateKey, { iat: now - 7200, exp: now - 3600 });
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("wrong issuer is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey, { issuer: "https://attacker.example.com" });
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("wrong audience is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey, { audience: "some-other-policy" });
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("token signed by a different key than the configured JWKS is rejected", async () => {
  const signingKeyPair = await keyPair();
  const unrelatedKeyPair = await keyPair();
  const jwks = await jwksFor(unrelatedKeyPair.publicKey);
  const token = await signToken(signingKeyPair.privateKey);
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

test("token with no email claim is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(POLICY_AUD)
    .sign(privateKey);
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD }, jwks);
  assert.equal(identity, null);
});

// --- Service Token auth (2026-10-08, see docs/AI-HANDOFF.md's "Morning
// Brief API" entry). A real Cloudflare Access service-token JWT never
// carries an `email` claim -- only `common_name` (the token's Client ID)
// and an empty `sub` (confirmed against Cloudflare's own JWT claims
// reference, not assumed). These tests sign JWTs shaped exactly that way,
// never adding an `email` claim, to prove this path is exercised
// honestly. ---

async function signServiceToken(privateKey, commonName, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ common_name: commonName, sub: "" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 3600)
    .setIssuer(overrides.issuer ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.audience ?? POLICY_AUD)
    .sign(privateKey);
}

test("a service-token JWT matching the allow-listed Client ID authenticates AS the owner email, not a separate identity", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signServiceToken(privateKey, "service-token-client-id-123");
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu", allowedServiceTokenClientId: "service-token-client-id-123" }, jwks);
  assert.deepEqual(identity, { email: "sgoldstein@nirc.edu" }, "a valid service token must resolve to the SAME identity as the owner, never a distinct 'service' identity");
});

test("a service-token JWT with a DIFFERENT Client ID than the allow-list is rejected", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signServiceToken(privateKey, "some-other-token-entirely");
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu", allowedServiceTokenClientId: "service-token-client-id-123" }, jwks);
  assert.equal(identity, null, "Access letting a request through is never sufficient on its own -- the app must independently verify it is THIS specific token");
});

test("a service-token JWT is rejected when no allow-list is configured at all (default/current behavior, unchanged)", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signServiceToken(privateKey, "service-token-client-id-123");
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu" }, jwks);
  assert.equal(identity, null, "service-token auth must stay OFF by default -- an app with no MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID configured must behave exactly as it did before this feature existed");
});

test("a service-token JWT is rejected when the allow-list is set but ownerEmail is not (never resolves to an identity with no owner to impersonate)", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signServiceToken(privateKey, "service-token-client-id-123");
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, allowedServiceTokenClientId: "service-token-client-id-123" }, jwks);
  assert.equal(identity, null, "a service token must never authenticate successfully without a concrete owner identity to resolve to");
});

test("a service token signed by the wrong key is still rejected -- the allow-list is never a substitute for signature verification", async () => {
  const signingKeyPair = await keyPair();
  const unrelatedKeyPair = await keyPair();
  const jwks = await jwksFor(unrelatedKeyPair.publicKey);
  const token = await signServiceToken(signingKeyPair.privateKey, "service-token-client-id-123");
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu", allowedServiceTokenClientId: "service-token-client-id-123" }, jwks);
  assert.equal(identity, null);
});

test("a human (email-bearing) token is unaffected by service-token config being present -- the two paths never interfere", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey); // real email, no common_name
  const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: "sgoldstein@nirc.edu", allowedServiceTokenClientId: "service-token-client-id-123" }, jwks);
  assert.deepEqual(identity, { email: "sgoldstein@nirc.edu" });
});
