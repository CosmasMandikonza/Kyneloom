/**
 * Pure playback engine for the Living Replay (KYN-06).
 *
 * `playheadMs` is the single source of time truth (docs/08): every transport
 * operation is a pure function over it, so pause/seek/reset/speed cannot
 * drift — the rendered pose at time t is always recomputed from t, never
 * integrated from the previous frame. Units are explicit everywhere: this
 * module speaks ONLY absolute match milliseconds.
 */

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** Fixture sample cadence in the golden window; one frame step = one sample. */
export const FRAME_STEP_MS = 100;

export interface PlaybackWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export function isPlaybackSpeed(value: number): value is PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

export function clampPlayhead(ms: number, window: PlaybackWindow): number {
  if (!Number.isFinite(ms)) return window.startMs;
  return Math.min(window.endMs, Math.max(window.startMs, ms));
}

/** Deterministic reset: the confirmed 22-player-plus-ball checkpoint. */
export function resetPlayhead(window: PlaybackWindow, focusMs: number): number {
  return clampPlayhead(focusMs, window);
}

export interface AdvanceResult {
  readonly playheadMs: number;
  /** True when playback hit the window end and must stop (not loop). */
  readonly atEnd: boolean;
}

/** Advance by real elapsed ms at the given speed; clamp and report end. */
export function advancePlayhead(
  currentMs: number,
  elapsedRealMs: number,
  speed: PlaybackSpeed,
  window: PlaybackWindow,
): AdvanceResult {
  const next = currentMs + elapsedRealMs * speed;
  if (next >= window.endMs) {
    return { playheadMs: window.endMs, atEnd: true };
  }
  if (next <= window.startMs) {
    return { playheadMs: window.startMs, atEnd: false };
  }
  return { playheadMs: next, atEnd: false };
}

/**
 * Frame-step onto the fixture's 100 ms sample grid (anchored at the window
 * start) so every step lands on a checkpoint of the golden cadence.
 */
export function stepFrame(
  currentMs: number,
  direction: 1 | -1,
  window: PlaybackWindow,
  stepMs: number = FRAME_STEP_MS,
): number {
  // Off-grid playheads always move a FULL step in the requested direction.
  const steps =
    direction === 1
      ? Math.floor((currentMs - window.startMs) / stepMs)
      : Math.ceil((currentMs - window.startMs) / stepMs);
  return clampPlayhead(window.startMs + (steps + direction) * stepMs, window);
}

/** Slider position as a 0–1 fraction of the moment window. */
export function playheadFraction(ms: number, window: PlaybackWindow): number {
  const span = window.endMs - window.startMs;
  return span <= 0 ? 0 : (ms - window.startMs) / span;
}

/** Inverse of playheadFraction — explicit ms at every boundary. */
export function fractionToPlayhead(fraction: number, window: PlaybackWindow): number {
  const span = window.endMs - window.startMs;
  return clampPlayhead(window.startMs + fraction * span, window);
}

export interface SceneEventLite {
  readonly occurredAtMs: number;
  readonly label: string;
  readonly kind: string;
  readonly actorId?: string;
}

export interface SceneEventInfo extends SceneEventLite {
  readonly isGoal: boolean;
}

/** The event the playhead is inside of (± tolerance) or the next upcoming one. */
export function eventAtPlayhead(
  ms: number,
  events: readonly SceneEventLite[],
  toleranceMs: number = 350,
): { event: SceneEventInfo; phase: 'active' | 'upcoming' } | null {
  let upcoming: SceneEventLite | null = null;
  for (const event of events) {
    if (Math.abs(event.occurredAtMs - ms) <= toleranceMs) {
      return { event: { ...event, isGoal: event.kind === 'goal' }, phase: 'active' };
    }
    if (event.occurredAtMs > ms && upcoming === null) {
      upcoming = event;
    }
  }
  if (upcoming === null) return null;
  return { event: { ...upcoming, isGoal: upcoming.kind === 'goal' }, phase: 'upcoming' };
}
