import type { TrackingSample } from '@kyneloom/contracts';

/**
 * Truthful timeline sampling (KYN-04, docs/08 time model).
 *
 * `sampleAt(timeMs)` is a PURE function of the accepted tracking set and the
 * query time: repeated, rewound, paused or out-of-order queries never
 * accumulate drift because every answer is recomputed from the samples, not
 * integrated from the previous answer.
 *
 * Truth rules:
 * - A sample that EXISTS at the query time is returned verbatim (exact pose,
 *   original source frame id, original origin).
 * - Between two samples of the SAME entity at most `maxInterpolationGapMs`
 *   apart, a linear interpolation is returned, disclosed as
 *   origin 'interpolated' with both source frame ids and the method —
 *   interpolation is visual reconstruction, never source evidence (docs/05).
 * - Before the first sample, after the last sample, or across a gap larger
 *   than the limit: the position is MISSING (explicitly absent, no stale
 *   last-known pose, no extrapolation, no invented coordinates). Full-time
 *   beyond the emitted window is therefore missing by construction.
 * - Coordinates stay in canonical pitch meters (+z up); the single shared
 *   pitchToThree transform remains the only conversion to renderer space.
 */

export interface TimelineOptions {
  /** Maximum gap between neighboring samples that may be interpolated across. */
  readonly maxInterpolationGapMs?: number;
}

export type SampleOrigin =
  'synthetic_ground_truth' | 'source_observed' | 'interpolated' | 'extrapolated';

export interface EntityTimelineSample {
  readonly entityId: string;
  readonly xM: number;
  readonly yM: number;
  readonly zM: number;
  /** True when a sample exists exactly at the query time. */
  readonly exact: boolean;
  readonly origin: SampleOrigin;
  /** Exact sample: its frame id. Interpolated: both neighboring frame ids. */
  readonly sourceFrameIds: readonly string[];
  /** Present only for interpolated results. */
  readonly interpolation?: {
    readonly fromMs: number;
    readonly toMs: number;
    readonly method: 'linear';
  };
}

export interface TimelineFrame {
  readonly queryTimeMs: number;
  readonly entities: readonly EntityTimelineSample[];
  /** Known entities (seen anywhere in tracking) with NO resolvable position. */
  readonly missingEntityIds: readonly string[];
}

export interface Timeline {
  readonly entityIds: readonly string[];
  readonly minTimeMs: number;
  readonly maxTimeMs: number;
  sampleAt(timeMs: number): TimelineFrame;
}

export function createTimeline(
  tracking: readonly TrackingSample[],
  options: TimelineOptions = {},
): Timeline {
  const maxGapMs = options.maxInterpolationGapMs ?? 400;
  const byEntity = new Map<string, TrackingSample[]>();
  for (const sample of tracking) {
    const list = byEntity.get(sample.entityId) ?? [];
    list.push(sample);
    byEntity.set(sample.entityId, list);
  }
  for (const list of byEntity.values()) {
    list.sort((a, b) => a.sampleTimeMs - b.sampleTimeMs);
  }
  const times = [...byEntity.values()].flat().map((s) => s.sampleTimeMs);
  const minTimeMs = times.length > 0 ? Math.min(...times) : 0;
  const maxTimeMs = times.length > 0 ? Math.max(...times) : 0;

  function sampleEntity(
    samples: readonly TrackingSample[],
    timeMs: number,
  ): EntityTimelineSample | null {
    // Exact sample (tracking times are integral milliseconds).
    for (const sample of samples) {
      if (sample.sampleTimeMs === timeMs) {
        return {
          entityId: sample.entityId,
          xM: sample.xM,
          yM: sample.yM,
          zM: sample.zM,
          exact: true,
          origin: sample.origin,
          sourceFrameIds: [sample.sourceFrameId],
        };
      }
    }
    // Neighbors straddling the query time.
    let before: TrackingSample | null = null;
    let after: TrackingSample | null = null;
    for (const sample of samples) {
      if (sample.sampleTimeMs < timeMs) before = sample;
      if (sample.sampleTimeMs > timeMs && after === null) after = sample;
    }
    if (before === null || after === null) return null; // outside observed span
    if (after.sampleTimeMs - before.sampleTimeMs > maxGapMs) return null; // large gap: absent
    if (before.entityId !== after.entityId) return null; // never happens; guard for clarity
    const span = after.sampleTimeMs - before.sampleTimeMs;
    const u = (timeMs - before.sampleTimeMs) / span;
    return {
      entityId: before.entityId,
      xM: round3(before.xM + (after.xM - before.xM) * u),
      yM: round3(before.yM + (after.yM - before.yM) * u),
      zM: round3(before.zM + (after.zM - before.zM) * u),
      exact: false,
      origin: 'interpolated',
      sourceFrameIds: [before.sourceFrameId, after.sourceFrameId],
      interpolation: { fromMs: before.sampleTimeMs, toMs: after.sampleTimeMs, method: 'linear' },
    };
  }

  return {
    entityIds: [...byEntity.keys()].sort(),
    minTimeMs,
    maxTimeMs,
    sampleAt(timeMs: number): TimelineFrame {
      if (!Number.isFinite(timeMs)) {
        throw new RangeError(`query time must be finite, got ${String(timeMs)}`);
      }
      const entities: EntityTimelineSample[] = [];
      const missing: string[] = [];
      for (const entityId of [...byEntity.keys()].sort()) {
        const sampled = sampleEntity(byEntity.get(entityId)!, timeMs);
        if (sampled === null) {
          missing.push(entityId);
        } else {
          entities.push(sampled);
        }
      }
      return { queryTimeMs: timeMs, entities, missingEntityIds: missing };
    },
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
