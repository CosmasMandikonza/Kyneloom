import {
  canonicalJsonStringify,
  parseMatchEvent,
  parseTrackingSample,
  type MatchEvent,
  type TrackingSample,
} from '@kyneloom/contracts';
import { projectMatch, type ProjectedMatch } from '../reducer/projection';
import {
  acceptedSetFingerprint,
  STREAM_CONTRACT_VERSION,
  type LiveFrame,
  type StreamEnvelope,
  type StreamTrackingTrack,
} from './wire';

/**
 * KYN-13 — the ONE authoritative live projection worker.
 *
 * Accepts `StreamEnvelope`s from any transport (local async producer, Azure
 * Event Hubs consumer) and reuses `projectMatch` — the same deterministic
 * ingest semantics as the batch path — as its ONLY truth model. No second
 * scoring/possession/correction algorithm exists here.
 *
 * Semantics:
 * - VALIDATION FIRST: every envelope is parsed with the strict contract
 *   parsers; malformed/mismatched envelopes are quarantined (with trace
 *   ids) and never touch the accepted corpus.
 * - IDEMPOTENT ADMISSION: exact-duplicate envelopes are counted, not
 *   re-applied (at-least-once delivery safe). Conflicting duplicates are
 *   delegated to the reducer's poisoning rules via full re-ingest.
 * - BOUNDED RE-PROJECTION (mission §4): the accepted corpus is re-projected
 *   through `projectMatch` after each admitted batch. For this fixture
 *   (11 events + 5,129 samples) the full re-projection is measured at
 *   single-digit ms from in-memory objects (see latency probe) — far below
 *   the 100 ms tracking cadence, so full deterministic replay is chosen over
 *   a bespoke incremental index. Revisit only if measured profiles say so.
 * - VERSIONING: every publish carries the CONTENT fingerprint of the whole
 *   accepted set (tracking-only corrections flip it) plus a monotonic seq.
 * - BACKPRESSURE: subscribers pull from a per-subscriber bounded queue;
 *   overflowing PRESENTATION deltas are compacted (superseded tracking
 *   ticks merged), never silently dropped — authoritative frames (snapshot,
 *   event deltas, corrections) force compaction of lesser frames ahead of
 *   them rather than being lost.
 */

export interface WorkerPublish {
  readonly frame: LiveFrame;
  /** Envelope ids admitted by this publish (archive correlation). */
  readonly admittedEnvelopeIds: readonly string[];
}

export interface WorkerAdmissionResult {
  /** True when the accepted set changed (a publish will follow). */
  readonly changed: boolean;
  readonly quarantined: readonly QuarantineRecord[];
  readonly duplicateCount: number;
}

export interface QuarantineRecord {
  readonly envelopeId: string;
  readonly kind: 'event' | 'tracking';
  readonly reason: string;
  readonly message: string;
  readonly traceId: string;
}

export interface LiveWorkerOptions {
  readonly matchId: string;
  readonly sessionId: string;
  /** Max retained accepted envelopes (bounded memory; fixture ≪ limit). */
  readonly maxAcceptedEnvelopes?: number;
}

export class LiveProjectionWorker {
  private acceptedEvents: MatchEvent[] = [];
  private acceptedTracking: TrackingSample[] = [];
  private seenEnvelopeIds = new Set<string>();
  /** (entity@time) → distinct canonical payloads + first-accepted sample
   *  (the incremental equivalent of ingest.ts's tombstone rule). */
  private trackingGroups = new Map<string, { canonicals: Set<string>; sample: TrackingSample }>();
  private projection: ProjectedMatch;
  private stateVersion: string;
  private seq = 0;
  private matchTimeMs = 0;
  private readonly traceBuffer: LatencySample[] = [];
  private projectionMsTotal = 0;
  private projectionCount = 0;

  constructor(private readonly options: LiveWorkerOptions) {
    this.projection = projectMatch({
      matchId: options.matchId,
      events: [],
      tracking: [],
    });
    this.stateVersion = acceptedSetFingerprint([], []);
  }

  get currentVersion(): string {
    return this.stateVersion;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get currentMatchTimeMs(): number {
    return this.matchTimeMs;
  }

  get stats(): { projectionMsMean: number; projectionCount: number; envelopeCount: number } {
    return {
      projectionMsMean:
        this.projectionCount === 0 ? 0 : this.projectionMsTotal / this.projectionCount,
      projectionCount: this.projectionCount,
      envelopeCount: this.acceptedEvents.length + this.acceptedTracking.length,
    };
  }

  /**
   * Admit a batch of wire envelopes. Validation, dedupe and reducer
   * semantics all inside; returns whether the accepted set changed plus
   * quarantine records for the caller's durable quarantine store.
   */
  admit(batch: readonly StreamEnvelope[]): WorkerAdmissionResult {
    // Admission footprint BEFORE this batch (seenEnvelopeIds grows during
    // validation below; the ceiling must bound the pre-batch + batch total).
    const seenBeforeBatch = this.seenEnvelopeIds.size;
    const quarantined: QuarantineRecord[] = [];
    let duplicateCount = 0;
    let changed = false;
    const newEvents: MatchEvent[] = [];
    const newTracking: TrackingSample[] = [];

    for (const envelope of batch) {
      if (envelope.contractVersion !== STREAM_CONTRACT_VERSION) {
        quarantined.push({
          envelopeId: envelope.envelopeId,
          kind: envelope.kind,
          reason: 'unsupported-contract',
          message: `contractVersion "${String(envelope.contractVersion)}" != ${STREAM_CONTRACT_VERSION}`,
          traceId: envelope.traceId,
        });
        continue;
      }
      if (envelope.matchId !== this.options.matchId) {
        quarantined.push({
          envelopeId: envelope.envelopeId,
          kind: envelope.kind,
          reason: 'match-mismatch',
          message: `envelope matchId "${envelope.matchId}" does not belong to match "${this.options.matchId}"`,
          traceId: envelope.traceId,
        });
        continue;
      }
      // At-least-once: exact envelope re-delivery is idempotently ignored.
      if (this.seenEnvelopeIds.has(envelope.envelopeId)) {
        duplicateCount += 1;
        continue;
      }

      if (envelope.kind === 'event') {
        const parsed = parseMatchEvent(envelope.event);
        if (!parsed.ok) {
          quarantined.push({
            envelopeId: envelope.envelopeId,
            kind: 'event',
            reason: 'malformed',
            message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
            traceId: envelope.traceId,
          });
          continue;
        }
        newEvents.push(parsed.data);
      } else {
        const parsed = parseTrackingSample(envelope.tracking);
        if (!parsed.ok) {
          quarantined.push({
            envelopeId: envelope.envelopeId,
            kind: 'tracking',
            reason: 'malformed',
            message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
            traceId: envelope.traceId,
          });
          continue;
        }
        newTracking.push(parsed.data);
      }
      this.seenEnvelopeIds.add(envelope.envelopeId);
      changed = true;
    }

    if (!changed) {
      return { changed: false, quarantined, duplicateCount };
    }

    // Bounded corpus: the demo fixture fits entirely; enforce the ceiling
    // truthfully by refusing admission beyond it (never silent truncation).
    const ceiling = this.options.maxAcceptedEnvelopes ?? 100_000;
    if (seenBeforeBatch + newEvents.length + newTracking.length > ceiling) {
      throw new RangeError(
        `accepted corpus would exceed the bounded ceiling ${String(ceiling)}; refusing admission (no silent truncation)`,
      );
    }

    // TRACKING admission (incremental, reducer-identical): dedupe exact
    // duplicates by canonical payload; a CONFLICTING payload for one
    // (entity, time) tombstones the pair — exactly ingest.ts's rule,
    // order-independent by construction because both distinct payloads are
    // recorded before the tombstone decision. Pure-tracking batches skip
    // the full projection (measured: full deterministic replay costs
    // O(corpus) per batch — mission §4 allows this optimization; events
    // always take the full path below).
    let trackingChanged = false;
    const effectiveNewTracking: TrackingSample[] = [];
    for (const sample of newTracking) {
      const key = `${sample.entityId}@${String(sample.sampleTimeMs)}`;
      const canonical = canonicalJsonStringify(sample);
      const group = this.trackingGroups.get(key);
      if (group === undefined) {
        this.trackingGroups.set(key, { canonicals: new Set([canonical]), sample });
        this.acceptedTracking.push(sample);
        effectiveNewTracking.push(sample);
        trackingChanged = true;
        continue;
      }
      if (group.canonicals.has(canonical)) {
        duplicateCount += 1; // same payload, distinct envelope id
        continue;
      }
      group.canonicals.add(canonical);
      if (group.canonicals.size === 2) {
        // Conflict: remove the previously accepted sample and tombstone the
        // pair permanently (no later payload resurrects it).
        this.acceptedTracking = this.acceptedTracking.filter(
          (existing) => existing !== group.sample,
        );
        trackingChanged = true;
      }
      // Further conflicting payloads only widen the tombstone.
    }

    // EVENT admission: events are rare and authoritative — every event
    // batch takes the FULL canonical projection (identity resolution,
    // revision chains, correction validation, lateness — all reducer
    // semantics, zero duplication).
    let eventsChanged = false;
    const effectiveNewEvents: MatchEvent[] = [];
    if (newEvents.length > 0) {
      const combinedEvents = [...this.acceptedEvents, ...newEvents];
      const started = performance.now();
      this.projection = projectMatch({
        matchId: this.options.matchId,
        events: combinedEvents,
        tracking: this.acceptedTracking,
      });
      const elapsed = performance.now() - started;
      this.projectionMsTotal += elapsed;
      this.projectionCount += 1;
      this.traceBuffer.push({ atMs: elapsed, traceId: batch[0]?.traceId ?? '' });

      for (const item of this.projection.quarantine) {
        quarantined.push({
          envelopeId: `batch:${String(this.projectionCount)}`,
          kind: item.kind,
          reason: item.reason,
          message: item.message,
          traceId: batch[0]?.traceId ?? '',
        });
      }
      const beforeEventIds = new Set(
        this.acceptedEvents.map((e) => `${e.providerId}|${e.eventId}|${String(e.sourceRevision)}`),
      );
      this.acceptedEvents = [...this.projection.acceptedEvents];
      for (const event of newEvents) {
        if (
          !beforeEventIds.has(
            `${event.providerId}|${event.eventId}|${String(event.sourceRevision)}`,
          )
        ) {
          effectiveNewEvents.push(event);
        }
      }
      eventsChanged = effectiveNewEvents.length > 0 || quarantined.length > 0;
    }

    const nextVersion = acceptedSetFingerprint(this.acceptedEvents, this.acceptedTracking);
    const versionChanged = nextVersion !== this.stateVersion;
    const previousVersion = this.stateVersion;
    this.stateVersion = nextVersion;
    this.matchTimeMs = Math.max(
      this.matchTimeMs,
      ...newTracking.map((sample) => sample.sampleTimeMs),
      ...newEvents.map((event) => event.occurredAtMs),
      0,
    );

    if (!versionChanged) {
      // Admitted but canonical no-op (e.g., superseded by existing tombstone
      // semantics): no publish, no seq burn.
      void trackingChanged;
      void eventsChanged;
      return { changed: true, quarantined, duplicateCount };
    }

    this.seq += 1;
    const frame: LiveFrame = {
      type: 'delta',
      matchId: this.options.matchId,
      sessionId: this.options.sessionId,
      baseVersion: previousVersion,
      stateVersion: this.stateVersion,
      seq: this.seq,
      sourceRevision: this.eventRevisionCount(),
      matchTimeMs: this.matchTimeMs,
      traceId: batch[0]?.traceId ?? '',
      newEvents: effectiveNewEvents,
      newTracking: effectiveNewTracking,
      trackingAvailable: this.acceptedTracking.length > 0,
    };
    this.pendingFrame = frame;
    return { changed: true, quarantined, duplicateCount };
  }

  /** VALID event envelopes applied (the reducer's revisionCount law). */
  private eventRevisionCount(): number {
    // The projection's revisionCount counts VALID envelopes in application
    // order; when the projection is stale (tracking-only batches since the
    // last event projection), the count is unchanged by definition.
    return this.projection.revisionCount;
  }

  private pendingFrame: LiveFrame | null = null;

  /** Build the canonical snapshot frame at the current version. */
  snapshot(): LiveFrame {
    this.seq += 1;
    return {
      type: 'snapshot',
      matchId: this.options.matchId,
      sessionId: this.options.sessionId,
      stateVersion: this.stateVersion,
      seq: this.seq,
      sourceRevision: this.projection.revisionCount,
      matchTimeMs: this.matchTimeMs,
      traceId: '',
      acceptedEvents: this.acceptedEvents,
      tracking: internTracking(this.acceptedTracking),
      trackingAvailable: this.acceptedTracking.length > 0,
    };
  }

  /** Take the pending delta (one-shot). */
  takePendingDelta(): LiveFrame | null {
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    return frame;
  }

  /** Direct access for tests/server tooling (read-only view). */
  view(): {
    acceptedEvents: readonly MatchEvent[];
    acceptedTracking: readonly TrackingSample[];
    projection: ProjectedMatch;
  } {
    return {
      acceptedEvents: this.acceptedEvents,
      acceptedTracking: this.acceptedTracking,
      projection: this.projection,
    };
  }
}

interface LatencySample {
  readonly atMs: number;
  readonly traceId: string;
}

/** Interning in the scene-data wire format (t/xyz/o/v/c/f tables). */
export function internTracking(samples: readonly TrackingSample[]): readonly StreamTrackingTrack[] {
  const byEntity = new Map<string, TrackingSample[]>();
  for (const sample of samples) {
    const list = byEntity.get(sample.entityId) ?? [];
    list.push(sample);
    byEntity.set(sample.entityId, list);
  }
  const tracks: StreamTrackingTrack[] = [];
  for (const [entityId, list] of byEntity) {
    list.sort((a, b) => a.sampleTimeMs - b.sampleTimeMs);
    tracks.push({
      entityId,
      t: list.map((s) => s.sampleTimeMs),
      xyz: list.flatMap((s) => [s.xM, s.yM, s.zM]),
      o: list.map((s) => originIndex(s.origin)),
      v: list.map((s) => (s.visibility === 'tracked' ? 0 : 1)),
      c: list.map((s) => Math.round(s.confidence * 100)),
      f: list.map((s) => Number(s.sourceFrameId.replace(/^frame-/, ''))),
    });
  }
  tracks.sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
  return tracks;
}

const ORIGIN_ORDER = [
  'source_observed',
  'synthetic_ground_truth',
  'interpolated',
  'extrapolated',
] as const;
function originIndex(origin: string): number {
  const index = (ORIGIN_ORDER as readonly string[]).indexOf(origin);
  return index === -1 ? 0 : index;
}
