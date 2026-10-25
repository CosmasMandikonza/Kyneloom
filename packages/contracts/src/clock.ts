/**
 * Shared broadcast clock formatting (MM:SS) — the single implementation the
 * web clock helpers (KYN-05) and the deterministic compiler's fact sentences
 * (KYN-16) both use, so manifest text and on-screen clocks can never diverge.
 */

/** Format absolute match-relative ms as a broadcast clock MM:SS. */
export function formatBroadcastClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
