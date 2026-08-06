import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

export type AccessIdentity = { email: string };

export type AccessVerifyConfig = {
  teamDomain: string;
  policyAud: string;
  ownerEmail?: string;
};

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// Verifies a Cloudflare Access JWT against the team's published JWKS.
// Missing, malformed, expired, wrong-issuer, and wrong-audience tokens all
// collapse to null (unauthenticated) rather than throwing, so callers treat
// every rejection reason identically and never leak verification detail.
export async function verifyAccessToken(
  token: string | null,
  config: AccessVerifyConfig,
  jwks: JWTVerifyGetKey = jwksFor(config.teamDomain),
): Promise<AccessIdentity | null> {
  if (!token) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: `https://${config.teamDomain}`,
      audience: config.policyAud,
    }));
  } catch {
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) return null;
  if (config.ownerEmail && email.toLowerCase() !== config.ownerEmail.toLowerCase()) return null;

  return { email };
}
