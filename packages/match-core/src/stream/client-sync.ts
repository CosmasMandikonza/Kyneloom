import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { createTimeline, type Timeline } from '../reducer/timeline';
import {
  acceptedSetFingerprint,
  validateLiveFrame,
  type LiveConnectionStatus,
  type LiveFrame,
  type RemovedTrackingKey,
} from './wire';

/**
 * KYN-13 — the viewer-side live synchronization controller.
 *
 * Owns the canonical client rules (mission §6):
 * - First frame must be a SNAPSHOT; its stateVersion becomes the base.
 * - Deltas apply only against the EXACT base version; a version mismatch or
 *   a non-contiguous seq is a GAP → `resynchronizing` (the caller fetches a
 *   fresh snapshot; nothing is guessed). Snapshot issuance never advances
 *   the broadcast sequence (wire v2), so another viewer joining can NEVER
 *   cause a false gap here.
 * - DELTA SEMANTICS MIRROR THE REDUCER (review gate): event corrections
 *   REPLACE the superseded revision by identity ((providerId, eventId)) —
 *   append-only application would fork the client corpus from the server's
 *   accepted set and force permanent resync loops; `removedTracking`
 *   tombstone removals are applied before new ticks append.
 * - The client INDEPENDENTLY recomputes the accepted-set fingerprint from
 *   the applied corpus (match-core is isomorphic; snapshots are lossless)
 *   and asserts it equals the frame's stateVersion — end-to-end integrity,
 *   not trust. A failed verification rolls the corpus back completely.
 * - Bounded backlog: applied-corpus tracking grows only by admitted
 *   envelopes (server-bounded); presentation coalescing happens at the
 *   engine bridge, not here.
 * - Last VERIFIED state survives disconnects; the status is truthful and
 *   nothing is fabricated while degraded.
 */

export type SyncEvent =
  | { readonly type: 'status'; readonly status: LiveConnectionStatus; readonly detail: string }
  | {
      readonly type: 'applied';
      readonly stateVersion: string;
      readonly seq: number;
      readonly matchTimeMs: number;
      readonly sourceRevision: number;
      readonly timeline: Timeline;
      readonly acceptedEvents: readonly MatchEvent[];
      readonly trackingCount: number;
      readonly trackingAvailable: boolean;
    }
  | { readonly type: 'gap'; readonly expectedSeq: number; readonly receivedSeq: number };

export interface LiveSyncOptions {
  /** Callback receiving controller events (status/applied/gap). */
  readonly onEvent: (event: SyncEvent) => void;
  /** Snapshot provider for resynchronization (transport-specific). */
  readonly fetchSnapshot: () => Promise<LiveFrame | null>;
  /** Max applied tracking samples retained (bounded memory). */
  readonly maxTrackingSamples?: number;
}

export class LiveSyncController {
  private status: LiveConnectionStatus = 'connecting';
  private baseVersion: string | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private acceptedEvents: MatchEvent[] = [];
  private acceptedTracking: TrackingSample[] = [];
  private timeline: Timeline | null = null;
  private resyncing = false;
  private readonly maxTrackingSamples: number;

  constructor(private readonly options: LiveSyncOptions) {
    this.maxTrackingSamples = options.maxTrackingSamples ?? 200_000;
  }

  get currentStateVersion(): string | null {
    return this.baseVersion;
  }

  get currentTimeline(): Timeline | null {
    return this.timeline;
  }

  get currentStatus(): LiveConnectionStatus {
    return this.status;
  }

  setStatus(status: LiveConnectionStatus, detail: string): void {
    this.status = status;
    this.options.onEvent({ type: 'status', status, detail });
  }

  /** Transport signal: the link dropped. Last verified state stays. */
  onDisconnect(detail: string): void {
    this.setStatus('disconnected', detail);
  }

  /** Transport signal: the link is back — resynchronize before trusting. */
  async onReconnect(): Promise<void> {
    if (this.resyncing) return;
    this.resyncing = true;
    this.setStatus('resynchronizing', 'connection restored — fetching canonical snapshot');
    try {
      const snapshot = await this.options.fetchSnapshot();
      if (snapshot === null) {
        this.setStatus('reconnecting', 'snapshot unavailable — will retry');
        return;
      }
      // FAIL CLOSED (review round 2): 'connected' only after the candidate
      // snapshot PASSED shape + fingerprint verification. A rejected
      // snapshot keeps the last verified state and a truthful retryable
      // status — never a green light on unverified data.
      if (this.applyFrame(snapshot)) {
        this.setStatus('connected', 'resynchronized from canonical snapshot');
      } else {
        this.setStatus('reconnecting', 'snapshot verification failed — will retry');
      }
    } finally {
      this.resyncing = false;
    }
  }

  /** Apply a validated wire frame. Returns false when the frame was rejected. */
  applyFrame(rawFrame: unknown): boolean {
    const frame = validateLiveFrame(rawFrame);
    if (frame === null) {
      // A malformed frame is a stream integrity problem: force resync.
      void this.onReconnect();
      return false;
    }

    if (frame.type === 'status') {
      // Transport-level status is advisory; the controller keeps its own.
      return true;
    }

    if (frame.type === 'snapshot') {
      // Verify FIRST, commit LAST (review round 2): a tampered snapshot
      // (shape-valid but fingerprint-incorrect) must NEVER touch the last
      // verified corpus, sequence or timeline. Everything is computed into
      // candidates; state mutates only after verification passes.
      const candidateEvents = [...frame.acceptedEvents];
      const candidateTracking = [...frame.tracking];
      const verified = acceptedSetFingerprint(candidateEvents, candidateTracking);
      if (verified !== frame.stateVersion) {
        // Snapshot failed end-to-end integrity: reject (no mutation) and
        // resync for a retryable replacement.
        void this.onReconnect();
        return false;
      }
      this.acceptedEvents = candidateEvents;
      this.acceptedTracking = candidateTracking;
      this.lastSeq = frame.seq;
      // A snapshot ADOPTS its session generation: after a producer restart
      // the sequence space resets, and any in-flight frames from the dead
      // session are a stale generation by definition.
      this.baseVersion = frame.stateVersion;
      this.sessionId = frame.sessionId;
      this.timeline = createTimeline(this.acceptedTracking);
      this.options.onEvent({
        type: 'applied',
        stateVersion: frame.stateVersion,
        seq: frame.seq,
        matchTimeMs: frame.matchTimeMs,
        sourceRevision: frame.sourceRevision,
        timeline: this.timeline,
        acceptedEvents: this.acceptedEvents,
        trackingCount: this.acceptedTracking.length,
        trackingAvailable: frame.trackingAvailable,
      });
      return true;
    }

    // delta
    if (this.baseVersion === null) {
      // No snapshot yet — a delta can never be the first frame.
      void this.onReconnect();
      return false;
    }
    if (frame.sessionId !== this.sessionId) {
      // STALE GENERATION: this delta belongs to a session the client has
      // already moved beyond (a producer restart resets the sequence
      // space; a starved renderer can dispatch such in-flight frames long
      // after the new session's snapshot was applied). Its sequence is
      // meaningless in the current generation and its content is superseded
      // by the adopted snapshot — ignoring it is correct; treating it as a
      // gap would livelock the resync loop (every fresh snapshot invalidated
      // by another stale frame).
      return false;
    }
    if (frame.baseVersion !== this.baseVersion) {
      // Wrong base: gap → resync, never guess.
      this.options.onEvent({
        type: 'gap',
        expectedSeq: (this.lastSeq ?? 0) + 1,
        receivedSeq: frame.seq,
      });
      void this.onReconnect();
      return false;
    }
    const expectedSeq = (this.lastSeq ?? 0) + 1;
    if (frame.seq !== expectedSeq) {
      this.options.onEvent({
        type: 'gap',
        expectedSeq,
        receivedSeq: frame.seq,
      });
      void this.onReconnect();
      return false;
    }

    // Apply with reducer-mirroring semantics; keep the previous corpus for
    // full rollback if end-to-end verification fails.
    const previousEvents = this.acceptedEvents;
    const previousTracking = this.acceptedTracking;

    // 1. Tombstone removals (conflict rule) leave the corpus first.
    const removals = removedTrackingKeys(frame.removedTracking);
    let tracking = this.acceptedTracking;
    if (removals.size > 0) {
      tracking = this.acceptedTracking.filter(
        (sample) => !removals.has(`${sample.entityId}@${String(sample.sampleTimeMs)}`),
      );
    }
    // 2. Event corrections REPLACE superseded revisions by identity — the
    //    reducer's acceptedEvents law (append would fork the corpus).
    const replacedIdentities = new Set(
      frame.newEvents.map((event) => `${event.providerId}|${event.eventId}`),
    );
    const events =
      replacedIdentities.size > 0
        ? this.acceptedEvents.filter(
            (event) => !replacedIdentities.has(`${event.providerId}|${event.eventId}`),
          )
        : this.acceptedEvents;
    const nextTracking = [...tracking, ...frame.newTracking];
    if (nextTracking.length > this.maxTrackingSamples) {
      // Bounded: refuse beyond the ceiling (server is also bounded; this is
      // defense in depth) and resync rather than truncate silently.
      void this.onReconnect();
      return false;
    }
    this.acceptedEvents = [...events, ...frame.newEvents];
    this.acceptedTracking = nextTracking;

    const verified = acceptedSetFingerprint(this.acceptedEvents, this.acceptedTracking);
    if (verified !== frame.stateVersion) {
      // Integrity failure: roll back this delta's corpus entirely and resync.
      this.acceptedEvents = previousEvents;
      this.acceptedTracking = previousTracking;
      void this.onReconnect();
      return false;
    }
    this.baseVersion = frame.stateVersion;
    this.lastSeq = frame.seq;
    this.timeline = createTimeline(this.acceptedTracking);
    this.options.onEvent({
      type: 'applied',
      stateVersion: frame.stateVersion,
      seq: frame.seq,
      matchTimeMs: frame.matchTimeMs,
      sourceRevision: frame.sourceRevision,
      timeline: this.timeline,
      acceptedEvents: this.acceptedEvents,
      trackingCount: this.acceptedTracking.length,
      trackingAvailable: frame.trackingAvailable,
    });
    return true;
  }
}

function removedTrackingKeys(keys: readonly RemovedTrackingKey[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const key of keys ?? []) {
    set.add(`${key.entityId}@${String(key.sampleTimeMs)}`);
  }
  return set;
}
