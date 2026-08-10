export const TENURES = ['permanent', 'hired', 'temporary'] as const;
export type Tenure = (typeof TENURES)[number];

export const EXPIRY_KINDS = [
  'project_closed',
  'task_completed',
  'matter_closed',
  'date',
  'manual',
] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];

export const DEDICATIONS = ['shared', 'dedicated'] as const;
export type Dedication = (typeof DEDICATIONS)[number];

export interface Department {
  id: string;
  ventureId: string;
  name: string;
  createdAt: string;
}

export interface CreateDepartmentInput {
  ventureId: string;
  name: string;
}

const RANK: Record<Tenure, number> = { permanent: 3, hired: 2, temporary: 1 };

export function tenureRank(tenure: Tenure): number {
  return RANK[tenure];
}

/**
 * An agent may not report to a manager with a shorter tenure class. Without this
 * rule a temporary manager's expiry orphans permanent staff — the same defect as
 * nulling manager_id on delete.
 */
export function assertTenureOrdering(agent: Tenure, manager: Tenure): void {
  if (tenureRank(manager) < tenureRank(agent)) {
    throw new Error(
      `A ${agent} agent may not report to a manager with a shorter tenure (${manager}).`,
    );
  }
}
