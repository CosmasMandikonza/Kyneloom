import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * KYN-13 review gate A — operator control authorization.
 *
 * The live control route (producer stop/start/restart) MUTATES the shared
 * stream for every viewer, so it must NEVER be reachable anonymously. The
 * honest local mechanism: the route is DISABLED unless the operator
 * explicitly provisions a token in the server environment
 * (`KYNELOOM_LIVE_CONTROL_TOKEN`); requests must then present the same
 * token in the `x-kyneloom-live-control` header, compared in constant
 * time. No cookie (no CSRF surface), no fabricated role/tenant auth — real
 * operator identity is Issue #21's job. Public viewers keep the read-only
 * synthetic stream.
 */

export const LIVE_CONTROL_HEADER = 'x-kyneloom-live-control';
export const LIVE_CONTROL_TOKEN_ENV = 'KYNELOOM_LIVE_CONTROL_TOKEN';

export type LiveControlDecision =
  { ok: true } | { ok: false; code: 'control-disabled' | 'control-unauthorized' };

/**
 * Fail-closed decision for one control request.
 * - No provisioned token → `control-disabled` for EVERYONE (the route is
 *   off; this is the default in any deployment that lacks an operator).
 * - Wrong/missing header token → `control-unauthorized`.
 * - Exact match (constant-time over digests, so length never leaks) → allow.
 */
export function decideLiveControl(
  envToken: string | undefined,
  headerToken: string | null,
): LiveControlDecision {
  const provisioned = envToken !== undefined ? envToken.trim() : '';
  if (provisioned === '') {
    return { ok: false, code: 'control-disabled' };
  }
  if (headerToken === null || headerToken === '') {
    return { ok: false, code: 'control-unauthorized' };
  }
  const a = createHash('sha256').update(provisioned, 'utf-8').digest();
  const b = createHash('sha256').update(headerToken, 'utf-8').digest();
  if (!timingSafeEqual(a, b)) {
    return { ok: false, code: 'control-unauthorized' };
  }
  return { ok: true };
}
