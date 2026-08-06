import { headers } from "next/headers";
import { env } from "cloudflare:workers";
import { verifyAccessToken } from "../../lib/auth/cloudflare-access";
import type { AuthProvider } from "../../lib/auth/provider";

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export const cloudflareAccessAuthProvider: AuthProvider = {
  name: "cloudflare-access",
  async resolve() {
    const teamDomain = env.TEAM_DOMAIN;
    const policyAud = env.POLICY_AUD;
    if (!teamDomain || !policyAud) return null;

    const token = (await headers()).get(ACCESS_JWT_HEADER);
    const identity = await verifyAccessToken(token, {
      teamDomain,
      policyAud,
      ownerEmail: env.STAGING_OWNER_EMAIL,
    });
    if (!identity) return null;

    return { displayName: identity.email, email: identity.email, fullName: null };
  },
};
