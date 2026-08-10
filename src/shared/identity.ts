export const USER_ROLES = ['owner', 'staff', 'observer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface User {
  id: string;
  displayName: string;
  role: UserRole;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  displayName: string;
  role: UserRole;
}

export interface VentureGrant {
  userId: string;
  ventureId: string;
  grantedAt: string;
}

/** The owner reaches every venture. Everyone else reaches only what they were granted. */
export function hasVentureAccess(
  user: Pick<User, 'role' | 'enabled'>,
  ventureId: string,
  grantedVentureIds: readonly string[],
): boolean {
  if (!user.enabled) return false;
  if (user.role === 'owner') return true;
  return grantedVentureIds.includes(ventureId);
}
