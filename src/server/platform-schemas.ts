import { z } from 'zod';
import { containsObviousCredential } from './secret-safety.js';

const safeText = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !containsObviousCredential(value),
  { message: 'Free text appears to contain a credential; store a secure reference instead' },
);

const optionalSafeText = (maximum: number) => z.string().trim().max(maximum).refine(
  (value) => !containsObviousCredential(value),
  { message: 'Free text appears to contain a credential; store a secure reference instead' },
);

export const createPortfolioSchema = z.object({
  name: safeText(120),
}).strict();

export const createVentureSchema = z.object({
  portfolioId: z.string().uuid(),
  name: safeText(160),
  kind: z.enum(['company', 'saas', 'brand', 'research', 'campaign', 'other']),
  mission: safeText(10_000),
}).strict();

export const createWorkProjectSchema = z.object({
  ventureId: z.string().uuid(),
  name: safeText(200),
  objective: safeText(20_000),
  successCriteria: z.array(safeText(2_000)).min(1).max(50),
  constraints: z.array(safeText(2_000)).max(50).optional(),
}).strict();

export const projectIntakeSchema = createWorkProjectSchema.extend({
  summary: safeText(20_000),
}).strict();

export const submitProjectPlanSchema = z.object({
  summary: safeText(20_000),
  requestedByOrgAgentId: z.string().uuid().nullable().default(null),
}).strict();

export const decideApprovalSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  decisionNote: optionalSafeText(10_000).nullable().default(null),
}).strict();

export const idempotencyKeySchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional();
