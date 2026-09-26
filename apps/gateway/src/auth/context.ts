export type Role = "owner" | "admin" | "member";

export type ApiKeyScopeMode = "unrestricted" | "groups";

export type AuthCapabilities = {
  canManageUsers: boolean;
  canManageSharedMcps: boolean;
  canInvite: boolean;
};

export type AuthContext = {
  userId: string;
  username: string;
  role: Role;
  apiKeyId?: string;
  scopeMode?: ApiKeyScopeMode;
};

/** Unknown DB values default to groups so a bad row never widens the catalog. */
export function parseApiKeyScopeMode(
  raw: string | null | undefined,
): ApiKeyScopeMode {
  if (raw === "unrestricted" || raw === "groups") return raw;
  return "groups";
}

export function capabilitiesForRole(role: Role): AuthCapabilities {
  const elevated = role === "owner" || role === "admin";
  return {
    canManageUsers: elevated,
    canManageSharedMcps: elevated,
    canInvite: elevated,
  };
}

export function isElevatedRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function parseRole(raw: string | null | undefined): Role {
  if (raw === "owner" || raw === "admin" || raw === "member") return raw;
  return "member";
}
