/**
 * KYN-09 — the orb→stadium transition's explicit finite-state machine.
 *
 * Five user-visible phases plus a truthful fallback:
 *
 * | Phase        | Owner                          | Entry                        | Exit                          | Cleanup |
 * |--------------|--------------------------------|------------------------------|-------------------------------|---------|
 * | idle         | DOM editorial overlay + orb    | mount                        | START (CTA) or FAIL           | — |
 * | intro        | landing canvas camera          | START (unless reducedMotion) | PHASE_COMPLETE(intro) / SKIP  | orb dissolve uniforms armed |
 * | fragments    | InstancedMesh fragment field   | intro complete               | PHASE_COMPLETE(fragments) / SKIP | per-frame matrix animation stops |
 * | pitch_reveal | reveal scene (reused Stadium)  | fragments complete           | PHASE_COMPLETE(reveal) AND assetsReady (or max wait) / SKIP | fragment field fades out |
 * | ready        | router handoff to /explore     | above                        | unmount/navigation            | landing canvas + probe disposed |
 * | fallback     | DOM poster + plain CTA link    | FAIL in any phase            | page navigation               | WebGL loop already stopped |
 *
 * Laws (docs/17 §3, Issue #9):
 * - START is accepted ONLY in idle — rapid repeated clicks can never launch
 *   a second transition.
 * - SKIP is honored in every interruptible phase (intro, fragments,
 *   pitch_reveal) and jumps straight to ready.
 * - Reduced motion never enters choreography: START goes straight to ready.
 * - Asset readiness decides whether pitch_reveal may complete; after
 *   ASSET_MAX_WAIT_MS the reveal completes anyway and /explore shows its
 *   own honest loading chip (soft gate, never a trap).
 * - The machine is PURE: `step(state, event, config, now)` returns the next
 *   state; React and the canvas subscribe to it, nothing else owns phase.
 */

export type LandingPhase = 'idle' | 'intro' | 'fragments' | 'pitch_reveal' | 'ready' | 'fallback';

export type LandingFailure =
  'webgl-unavailable' | 'context-lost' | 'shader-error' | 'asset-timeout';

export interface LandingTransitionConfig {
  /** intro dolly duration in ms (idle → fragments pacing). */
  readonly introMs: number;
  /** fragment flight duration in ms. */
  readonly fragmentsMs: number;
  /** pitch reveal duration in ms (can hold longer awaiting assets). */
  readonly revealMs: number;
  /** Hard ceiling on waiting for warmed /explore assets (ms since START). */
  readonly assetMaxWaitMs: number;
  /** prefers-reduced-motion: choreography is skipped entirely. */
  readonly reducedMotion: boolean;
}

export const DEFAULT_LANDING_CONFIG: LandingTransitionConfig = {
  introMs: 900,
  fragmentsMs: 1900,
  revealMs: 1400,
  assetMaxWaitMs: 4000,
  reducedMotion: false,
};

export type LandingEvent =
  | { readonly type: 'START' }
  | { readonly type: 'SKIP' }
  | { readonly type: 'PHASE_COMPLETE'; readonly phase: 'intro' | 'fragments' | 'pitch_reveal' }
  | { readonly type: 'ASSETS_READY' }
  | { readonly type: 'FAIL'; readonly reason: LandingFailure };

export interface LandingTransitionState {
  readonly phase: LandingPhase;
  /** Caller-clock timestamp of the current phase entry (ms). */
  readonly phaseEnteredAtMs: number;
  /** START timestamp — gates the asset wait ceiling. */
  readonly startedAtMs: number | null;
  readonly assetsReady: boolean;
  readonly skipped: boolean;
  readonly failureReason: LandingFailure | null;
  /** How many START events have been accepted (rapid-click guard evidence). */
  readonly startCount: number;
}

export function initialLandingState(nowMs: number = 0): LandingTransitionState {
  return {
    phase: 'idle',
    phaseEnteredAtMs: nowMs,
    startedAtMs: null,
    assetsReady: false,
    skipped: false,
    failureReason: null,
    startCount: 0,
  };
}

export function stepLandingTransition(
  state: LandingTransitionState,
  event: LandingEvent,
  config: LandingTransitionConfig,
  nowMs: number,
): LandingTransitionState {
  // FAIL is honored from any live phase — WebGL loss mid-transition must
  // degrade truthfully, never freeze the CTA.
  if (event.type === 'FAIL') {
    if (state.phase === 'fallback' || state.phase === 'ready') return state;
    return {
      ...state,
      phase: 'fallback',
      phaseEnteredAtMs: nowMs,
      failureReason: event.reason,
    };
  }

  switch (state.phase) {
    case 'idle':
      if (event.type === 'START') {
        // Reduced motion leads straight to the real replay — no
        // choreography, no waiting (Issue #9 acceptance 8).
        if (config.reducedMotion) {
          return {
            ...state,
            phase: 'ready',
            phaseEnteredAtMs: nowMs,
            startedAtMs: nowMs,
            startCount: state.startCount + 1,
          };
        }
        return {
          ...state,
          phase: 'intro',
          phaseEnteredAtMs: nowMs,
          startedAtMs: nowMs,
          startCount: state.startCount + 1,
        };
      }
      return state;

    case 'intro':
      if (event.type === 'START') return state; // rapid-click lockout
      if (event.type === 'SKIP') return skipToReady(state, nowMs);
      if (event.type === 'ASSETS_READY') return { ...state, assetsReady: true };
      if (event.type === 'PHASE_COMPLETE' && event.phase === 'intro') {
        return { ...state, phase: 'fragments', phaseEnteredAtMs: nowMs };
      }
      return state;

    case 'fragments':
      if (event.type === 'START') return state;
      if (event.type === 'SKIP') return skipToReady(state, nowMs);
      if (event.type === 'ASSETS_READY') return { ...state, assetsReady: true };
      if (event.type === 'PHASE_COMPLETE' && event.phase === 'fragments') {
        return { ...state, phase: 'pitch_reveal', phaseEnteredAtMs: nowMs };
      }
      return state;

    case 'pitch_reveal':
      if (event.type === 'START') return state;
      if (event.type === 'SKIP') return skipToReady(state, nowMs);
      if (event.type === 'ASSETS_READY') return { ...state, assetsReady: true };
      if (event.type === 'PHASE_COMPLETE' && event.phase === 'pitch_reveal') {
        // Asset readiness decides completion — but never traps the user:
        // after assetMaxWaitMs the reveal completes and /explore shows its
        // own loading chip.
        const waitedMs = state.startedAtMs === null ? Infinity : nowMs - state.startedAtMs;
        if (state.assetsReady || waitedMs >= config.assetMaxWaitMs) {
          return { ...state, phase: 'ready', phaseEnteredAtMs: nowMs };
        }
        return state; // hold the (looping) reveal until assets or ceiling
      }
      return state;

    case 'ready':
    case 'fallback':
      return state; // terminal for this page instance
  }
}

function skipToReady(state: LandingTransitionState, nowMs: number): LandingTransitionState {
  return { ...state, phase: 'ready', phaseEnteredAtMs: nowMs, skipped: true };
}

/** True while the phase can still be interrupted by Skip (Issue #9 #7). */
export function isInterruptible(phase: LandingPhase): boolean {
  return phase === 'intro' || phase === 'fragments' || phase === 'pitch_reveal';
}

/** Milliseconds spent in the current phase (caller clock). */
export function phaseElapsedMs(state: LandingTransitionState, nowMs: number): number {
  return nowMs - state.phaseEnteredAtMs;
}

/**
 * Which named canvas layer owns rendering this phase. Exactly one owner per
 * phase; the previous owner cleans up when ownership changes.
 */
export type LandingLayerOwner = 'orb' | 'orb+fragments' | 'reveal' | 'none';
export function layerOwner(phase: LandingPhase): LandingLayerOwner {
  switch (phase) {
    case 'idle':
    case 'intro':
      return 'orb';
    case 'fragments':
      return 'orb+fragments';
    case 'pitch_reveal':
      return 'reveal';
    case 'ready':
    case 'fallback':
      return 'none';
  }
}
