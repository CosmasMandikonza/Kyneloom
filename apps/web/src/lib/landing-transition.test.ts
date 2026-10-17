import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANDING_CONFIG,
  initialLandingState,
  isInterruptible,
  layerOwner,
  phaseElapsedMs,
  stepLandingTransition,
  type LandingTransitionState,
} from './landing-transition';

/**
 * KYN-09 — the transition FSM is pure and fully deterministic; these tests
 * pin the Issue #9 acceptance laws: five states in order, rapid-click
 * lockout, skip everywhere, reduced-motion bypass, asset gate with a
 * ceiling, truthful fallback.
 */

const C = DEFAULT_LANDING_CONFIG;
const T0 = 1_000_000; // arbitrary caller clock

function run(
  events: Parameters<typeof stepLandingTransition>[1][],
  config = C,
  start: LandingTransitionState = initialLandingState(T0),
): LandingTransitionState {
  let state = start;
  let now = T0;
  for (const event of events) {
    now += 100;
    state = stepLandingTransition(state, event, config, now);
  }
  return state;
}

describe('landing transition FSM', () => {
  it('happy path: idle → intro → fragments → pitch_reveal → ready', () => {
    const s1 = run([{ type: 'START' }]);
    expect(s1.phase).toBe('intro');
    const s2 = run([{ type: 'PHASE_COMPLETE', phase: 'intro' }], C, s1);
    expect(s2.phase).toBe('fragments');
    const s3 = run([{ type: 'PHASE_COMPLETE', phase: 'fragments' }], C, s2);
    expect(s3.phase).toBe('pitch_reveal');
    // Assets ready → the reveal may complete.
    const s4 = run(
      [{ type: 'ASSETS_READY' }, { type: 'PHASE_COMPLETE', phase: 'pitch_reveal' }],
      C,
      s3,
    );
    expect(s4.phase).toBe('ready');
  });

  it('rapid repeated START clicks can never launch a second transition', () => {
    const s1 = run([{ type: 'START' }]);
    const s2 = run([{ type: 'START' }, { type: 'START' }, { type: 'START' }], C, s1);
    expect(s2.phase).toBe('intro');
    expect(s2.startCount).toBe(1);
  });

  it('SKIP is honored in every interruptible phase and jumps to ready', () => {
    for (const phase of ['intro', 'fragments', 'pitch_reveal'] as const) {
      const state: LandingTransitionState = {
        ...initialLandingState(T0),
        phase,
        startedAtMs: T0,
        startCount: 1,
      };
      const skipped = run([{ type: 'SKIP' }], C, state);
      expect(skipped.phase).toBe('ready');
      expect(skipped.skipped).toBe(true);
    }
  });

  it('reduced motion: START goes straight to ready — no choreography', () => {
    const state = run([{ type: 'START' }], { ...C, reducedMotion: true });
    expect(state.phase).toBe('ready');
    expect(state.startCount).toBe(1);
  });

  it('asset readiness gates the reveal exit — but the ceiling never traps', () => {
    const s3 = run([
      { type: 'START' },
      { type: 'PHASE_COMPLETE', phase: 'intro' },
      { type: 'PHASE_COMPLETE', phase: 'fragments' },
    ]);
    // Reveal completes its own budget but assets are NOT ready: hold.
    const held = run([{ type: 'PHASE_COMPLETE', phase: 'pitch_reveal' }], C, s3);
    expect(held.phase).toBe('pitch_reveal');
    // After assetMaxWaitMs since START, the same completion event passes.
    const state = stepLandingTransition(
      held,
      { type: 'PHASE_COMPLETE', phase: 'pitch_reveal' },
      C,
      (held.startedAtMs ?? T0) + C.assetMaxWaitMs + 50,
    );
    expect(state.phase).toBe('ready');
  });

  it('redundant PHASE_COMPLETE while held is a no-op (idempotent re-fire)', () => {
    const s3 = run([
      { type: 'START' },
      { type: 'PHASE_COMPLETE', phase: 'intro' },
      { type: 'PHASE_COMPLETE', phase: 'fragments' },
    ]);
    const again = run(
      [
        { type: 'PHASE_COMPLETE', phase: 'pitch_reveal' },
        { type: 'PHASE_COMPLETE', phase: 'pitch_reveal' },
      ],
      C,
      s3,
    );
    expect(again.phase).toBe('pitch_reveal');
  });

  it('FAIL in any live phase degrades truthfully to fallback', () => {
    for (const phase of ['idle', 'intro', 'fragments', 'pitch_reveal'] as const) {
      const state: LandingTransitionState = {
        ...initialLandingState(T0),
        phase,
        startedAtMs: phase === 'idle' ? null : T0,
        startCount: phase === 'idle' ? 0 : 1,
      };
      const failed = run([{ type: 'FAIL', reason: 'context-lost' }], C, state);
      expect(failed.phase).toBe('fallback');
      expect(failed.failureReason).toBe('context-lost');
    }
  });

  it('START after fallback is inert (the fallback CTA navigates directly)', () => {
    const failed = run([{ type: 'FAIL', reason: 'webgl-unavailable' }]);
    expect(run([{ type: 'START' }], C, failed).phase).toBe('fallback');
  });

  it('exactly one layer owner per phase; every choreography phase is interruptible', () => {
    expect(layerOwner('idle')).toBe('orb');
    expect(layerOwner('intro')).toBe('orb');
    expect(layerOwner('fragments')).toBe('orb+fragments');
    expect(layerOwner('pitch_reveal')).toBe('reveal');
    expect(layerOwner('ready')).toBe('none');
    expect(layerOwner('fallback')).toBe('none');
    expect(isInterruptible('intro')).toBe(true);
    expect(isInterruptible('fragments')).toBe(true);
    expect(isInterruptible('pitch_reveal')).toBe(true);
    expect(isInterruptible('idle')).toBe(false);
    expect(isInterruptible('ready')).toBe(false);
    expect(isInterruptible('fallback')).toBe(false);
  });

  it('phaseElapsedMs uses the caller clock', () => {
    const state = initialLandingState(T0);
    expect(phaseElapsedMs(state, T0 + 250)).toBe(250);
  });
});
