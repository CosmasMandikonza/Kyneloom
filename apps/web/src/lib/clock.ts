/**
 * Client-safe broadcast clock formatting (moved out of match-fixture.ts,
 * which imports node:fs and must never load in the browser).
 */

/** Format absolute match-relative ms as a broadcast clock MM:SS. */
export function formatMatchClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** MM:SS.d — tenths make scrubbing and slow motion legible. */
export function formatMatchClockTenths(ms: number): string {
  const tenths = Math.floor((ms % 1000) / 100);
  return `${formatMatchClock(ms)}.${tenths}`;
}
