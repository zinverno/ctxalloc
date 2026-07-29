import { z } from 'zod';

/**
 * Tenant, workspace, and optional project boundary (INV-SCOPE-001, DEC-019).
 *
 * Scope values are project-owned opaque strings. No default scope is injected:
 * local execution must supply explicit values such as `local` / `default`, so
 * that an unscoped record is always a validation failure rather than a silently
 * assumed default (REJ-007).
 */
const scopeIdentifier = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

export const ScopeSchema = z.strictObject({
  tenantId: scopeIdentifier,
  workspaceId: scopeIdentifier,
  projectId: scopeIdentifier.optional(),
});

export type Scope = Readonly<z.infer<typeof ScopeSchema>>;

/**
 * Deterministic structural equality for scopes.
 *
 * An absent `projectId` and an explicit `undefined` `projectId` describe the
 * same boundary and therefore compare equal. Cross-scope *filtering* is a
 * compiler concern (INV-SCOPE-003) and is intentionally not implemented here.
 */
export function scopesEqual(a: Scope, b: Scope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.workspaceId === b.workspaceId &&
    (a.projectId ?? null) === (b.projectId ?? null)
  );
}
