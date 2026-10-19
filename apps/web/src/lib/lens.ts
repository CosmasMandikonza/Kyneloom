/**
 * KYN-11 — the lens presentation-state layer (pure, client-safe).
 *
 * A lens is a PRESENTATION choice, never an identity or authorization
 * (docs/02 "role versus lens"; issue #11). The public set is
 * `fan | analyst | accessible`. A `producer_preview` presentation may only
 * ever be derived from a real server-validated permission — it can never
 * be set from client state, storage or a URL, so it deliberately has no
 * public setter here.
 *
 * HARD INVARIANT (asserted by tests and by the runtime): switching lenses
 * must never touch the match id, source revision, playhead, playback state,
 * selected player, canonical positions, ball state, event/claim ids,
 * metric results, evidence provenance or verification results. A lens may
 * only change camera framing (on explicit user request), overlay/panel
 * visibility, presentation language, transcript visibility and layout.
 */

/** The public viewing lenses. */
export const LENS_IDS = ['fan', 'analyst', 'accessible'] as const;
export type LensId = (typeof LENS_IDS)[number];

export function isLensId(value: unknown): value is LensId {
  return typeof value === 'string' && (LENS_IDS as readonly string[]).includes(value);
}

/** Invalid, malformed or absent values always fall back to Fan. */
export function normalizeLens(value: unknown): LensId {
  return isLensId(value) ? value : 'fan';
}

/**
 * Session persistence policy (documented): the chosen lens is remembered
 * ONLY for the tab session, ONLY as this presentation preference, and is
 * read/written from client effects (never during SSR render, so hydration
 * cannot mismatch). Nothing else — no positions, metrics, selections or
 * anything authorization-shaped — is ever stored under this key.
 */
export const LENS_STORAGE_KEY = 'kyneloom.lens';

/** Safe read for any Storage-like object; malformed values revert to Fan. */
export function readStoredLens(storage: Pick<Storage, 'getItem'> | null | undefined): LensId {
  if (storage === null || storage === undefined) return 'fan';
  try {
    return normalizeLens(storage.getItem(LENS_STORAGE_KEY));
  } catch {
    return 'fan';
  }
}

/** Safe write; failures (quota, privacy mode) silently keep session-only. */
export function storeLens(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  lens: LensId,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(LENS_STORAGE_KEY, lens);
  } catch {
    /* preference stays session-only */
  }
}

export const LENS_LABELS: Record<LensId, string> = {
  fan: 'Fan',
  analyst: 'Analyst',
  accessible: 'Accessible',
};

export const LENS_HINTS: Record<LensId, string> = {
  fan: 'Cinematic replay — the story of the moment',
  analyst: 'Measurements, geometry and source evidence',
  accessible: 'Spatial descriptions, transcript and audio controls',
};
