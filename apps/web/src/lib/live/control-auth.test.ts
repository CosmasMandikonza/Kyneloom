import { describe, expect, it } from 'vitest';
import { decideLiveControl } from './control-auth';

/**
 * KYN-13 review gate A — the operator control route fails closed. These are
 * the authorization DECISIONS; the live browser QA additionally proves the
 * real HTTP behavior (anonymous POST → 403, stream untouched).
 */
describe('live control authorization', () => {
  it('no provisioned token ⇒ disabled for EVERYONE (fail closed)', () => {
    expect(decideLiveControl(undefined, null)).toEqual({ ok: false, code: 'control-disabled' });
    expect(decideLiveControl(undefined, 'anything')).toEqual({
      ok: false,
      code: 'control-disabled',
    });
    expect(decideLiveControl('', 'anything')).toEqual({ ok: false, code: 'control-disabled' });
    expect(decideLiveControl('   ', 'anything')).toEqual({ ok: false, code: 'control-disabled' });
  });

  it('provisioned but missing/wrong header token ⇒ unauthorized', () => {
    expect(decideLiveControl('secret-token', null)).toEqual({
      ok: false,
      code: 'control-unauthorized',
    });
    expect(decideLiveControl('secret-token', '')).toEqual({
      ok: false,
      code: 'control-unauthorized',
    });
    expect(decideLiveControl('secret-token', 'wrong-token')).toEqual({
      ok: false,
      code: 'control-unauthorized',
    });
    // Near-miss tokens never pass (constant-time digest comparison).
    expect(decideLiveControl('secret-token', 'secret-tokes')).toEqual({
      ok: false,
      code: 'control-unauthorized',
    });
  });

  it('exact token ⇒ allowed (the local operator/QA workflow)', () => {
    expect(decideLiveControl('secret-token', 'secret-token')).toEqual({ ok: true });
  });
});
