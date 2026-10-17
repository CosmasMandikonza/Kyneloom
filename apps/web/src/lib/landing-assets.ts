/**
 * KYN-09 — truthful /explore asset warming (review gate 3).
 *
 * `ASSETS_READY` must only ever mean "the required assets genuinely
 * arrived": HTTP 200 responses, no network errors, no aborts. A 404, a
 * blocked network, or an aborted/slow load returns FALSE and the transition
 * relies on the FSM's bounded ceiling instead (the user still reaches
 * /explore, where the normal loading chip and WebGL/2D fallbacks take
 * over — never a trap, never a fabricated "ready").
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Warm the heavy /explore assets. Returns true ONLY when every required
 * asset responded ok. Never throws: failures are reported as `false`.
 */
export async function warmExploreAssets(
  urls: readonly string[],
  fetchImpl: FetchLike,
  init?: RequestInit,
): Promise<boolean> {
  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await fetchImpl(url, init);
          return response.ok;
        } catch {
          return false; // network failure / abort — NOT ready
        }
      }),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

/** The assets whose presence lets the reveal complete as "verified ready". */
export const EXPLORE_ASSETS = ['/models/footballer.glb'] as const;

/** Upper bound on warming before the caller gives up (caller may abort sooner). */
export const ASSET_WARM_TIMEOUT_MS = 8_000;
