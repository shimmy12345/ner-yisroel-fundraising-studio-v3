export type AuthenticatedIdentity = {
  displayName: string;
  email: string;
  fullName: string | null;
};

export type AuthProvider = {
  name: string;
  resolve(): Promise<AuthenticatedIdentity | null>;
};

export async function resolveIdentity(providers: AuthProvider[]): Promise<AuthenticatedIdentity | null> {
  for (const provider of providers) {
    const identity = await provider.resolve();
    if (identity) return identity;
  }
  return null;
}
