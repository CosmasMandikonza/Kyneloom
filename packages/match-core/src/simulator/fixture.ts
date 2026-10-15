import {
  parseMatchEvent,
  parseTrackingSample,
  type MatchEvent,
  type TrackingSample,
} from '@kyneloom/contracts';
import type { FixtureMetadata } from './simulate';

/**
 * Pure fixture-loading interface (KYN-03) for downstream consumers — the
 * future R3F renderer included. No filesystem access here on purpose: the
 * web server / scripts read the JSON files and hand the parsed values to
 * `assembleFixtureBundle`, which validates every envelope and sample against
 * the canonical contracts and returns typed accessors. Missing data stays
 * missing: this interface never interpolates, fills, or regenerates match
 * truth (that is the renderer sampler's disclosed job, docs/08).
 */

export interface FixtureBundleSource {
  readonly events: readonly unknown[];
  readonly tracking: readonly unknown[];
  readonly metadata: unknown;
}

export interface LoadedFixtureBundle {
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
  readonly metadata: FixtureMetadata;
  /** All distinct frame times in ascending order. */
  readonly frameTimesMs: readonly number[];
  /** Samples for one entity in time order (empty array = explicitly no data). */
  entityTrack(entityId: string): readonly TrackingSample[];
  /** The full frame at a time (all entities present in that frame). */
  frameAt(timeMs: number): ReadonlyMap<string, TrackingSample>;
  /** Events with occurredAtMs in [fromMs, toMs]. */
  eventsBetween(fromMs: number, toMs: number): readonly MatchEvent[];
}

export interface FixtureLoadError {
  readonly index: number;
  readonly kind: 'event' | 'tracking' | 'metadata';
  readonly message: string;
}

export type FixtureBundleResult =
  | { readonly ok: true; readonly bundle: LoadedFixtureBundle }
  | { readonly ok: false; readonly errors: FixtureLoadError[] };

function isMetadataShape(value: unknown): value is FixtureMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['matchId'] === 'string' &&
    typeof m['seed'] === 'number' &&
    typeof m['generatorVersion'] === 'string' &&
    typeof m['sampling'] === 'object' &&
    m['sampling'] !== null &&
    typeof (m['sampling'] as Record<string, unknown>)['sampleCount'] === 'number'
  );
}

export function assembleFixtureBundle(source: FixtureBundleSource): FixtureBundleResult {
  const errors: FixtureLoadError[] = [];

  const events: MatchEvent[] = [];
  for (const [index, raw] of source.events.entries()) {
    const parsed = parseMatchEvent(raw);
    if (parsed.ok) {
      events.push(parsed.data);
    } else {
      errors.push({
        index,
        kind: 'event',
        message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
      });
    }
  }

  const tracking: TrackingSample[] = [];
  for (const [index, raw] of source.tracking.entries()) {
    const parsed = parseTrackingSample(raw);
    if (parsed.ok) {
      tracking.push(parsed.data);
    } else {
      errors.push({
        index,
        kind: 'tracking',
        message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
      });
    }
  }

  if (!isMetadataShape(source.metadata)) {
    errors.push({
      index: 0,
      kind: 'metadata',
      message:
        'metadata is missing required fields (matchId, seed, generatorVersion, sampling.sampleCount)',
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const metadata = source.metadata as FixtureMetadata;
  const frameTimesMs = [...new Set(tracking.map((s) => s.sampleTimeMs))].sort((a, b) => a - b);
  const byEntity = new Map<string, TrackingSample[]>();
  for (const sample of tracking) {
    const list = byEntity.get(sample.entityId) ?? [];
    list.push(sample);
    byEntity.set(sample.entityId, list);
  }
  const byTime = new Map<number, Map<string, TrackingSample>>();
  for (const sample of tracking) {
    const frame = byTime.get(sample.sampleTimeMs) ?? new Map<string, TrackingSample>();
    frame.set(sample.entityId, sample);
    byTime.set(sample.sampleTimeMs, frame);
  }

  return {
    ok: true,
    bundle: {
      events,
      tracking,
      metadata,
      frameTimesMs,
      entityTrack: (entityId) =>
        (byEntity.get(entityId) ?? []).slice().sort((a, b) => a.sampleTimeMs - b.sampleTimeMs),
      frameAt: (timeMs) => byTime.get(timeMs) ?? new Map<string, TrackingSample>(),
      eventsBetween: (fromMs, toMs) =>
        events.filter((e) => e.occurredAtMs >= fromMs && e.occurredAtMs <= toMs),
    },
  };
}
