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
