import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { createTimeline, type Timeline } from '../reducer/timeline';
import {
  acceptedSetFingerprint,
  validateLiveFrame,
  type LiveConnectionStatus,
  type LiveFrame,
  type StreamTrackingTrack,
} from './wire';

/**
 * KYN-13 — the viewer-side live synchronization controller.
 *
 * Owns the canonical client rules (mission §6):
 * - First frame must be a SNAPSHOT; its stateVersion becomes the base.
 * - Deltas apply only against the EXACT base version; a version mismatch or
 *   a non-contiguous seq is a GAP → `resynchronizing` (the caller fetches a
 *   fresh snapshot; nothing is guessed).
 * - The client INDEPENDENTLY recomputes the accepted-set fingerprint from
 *   the applied corpus (match-core is isomorphic) and asserts it equals the
 *   frame's stateVersion — end-to-end integrity, not trust.
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
      this.applyFrame(snapshot);
      this.setStatus('connected', 'resynchronized from canonical snapshot');
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
      this.acceptedEvents = [...frame.acceptedEvents];
      this.acceptedTracking = deintern(frame.tracking);
      this.lastSeq = frame.seq;
      const verified = acceptedSetFingerprint(this.acceptedEvents, this.acceptedTracking);
      if (verified !== frame.stateVersion) {
        // Snapshot failed end-to-end integrity: reject and resync.
        void this.onReconnect();
        return false;
      }
      this.baseVersion = frame.stateVersion;
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

    const nextTracking = [...this.acceptedTracking, ...frame.newTracking];
    if (nextTracking.length > this.maxTrackingSamples) {
      // Bounded: refuse beyond the ceiling (server is also bounded; this is
      // defense in depth) and resync rather than truncate silently.
      void this.onReconnect();
      return false;
    }
    this.acceptedEvents = [...this.acceptedEvents, ...frame.newEvents];
    this.acceptedTracking = nextTracking;
    const verified = acceptedSetFingerprint(this.acceptedEvents, this.acceptedTracking);
    if (verified !== frame.stateVersion) {
      // Integrity failure: roll back this delta's corpus and resync.
      this.acceptedEvents = this.acceptedEvents.slice(
        0,
        this.acceptedEvents.length - frame.newEvents.length,
      );
      this.acceptedTracking = this.acceptedTracking.slice(
        0,
        this.acceptedTracking.length - frame.newTracking.length,
      );
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

/** Rehydrate interned tracks back to canonical samples (scene-client parity). */
export function deintern(tracks: readonly StreamTrackingTrack[]): TrackingSample[] {
  const origins = [
    'source_observed',
    'synthetic_ground_truth',
    'interpolated',
    'extrapolated',
  ] as const;
  const samples: TrackingSample[] = [];
  for (const track of tracks) {
    for (let i = 0; i < track.t.length; i += 1) {
      samples.push({
        schemaVersion: '1.0',
        matchId: '',
        sampleTimeMs: track.t[i]!,
        entityId: track.entityId,
        xM: track.xyz[i * 3]!,
        yM: track.xyz[i * 3 + 1]!,
        zM: track.xyz[i * 3 + 2]!,
        origin: origins[track.o[i] ?? 1] ?? 'synthetic_ground_truth',
        confidence: (track.c[i] ?? 100) / 100,
        visibility: (track.v[i] ?? 0) === 0 ? 'tracked' : 'partial',
        sourceFrameId: `frame-${String(track.f[i] ?? 0)}`,
      });
    }
  }
  samples.sort((a, b) => a.sampleTimeMs - b.sampleTimeMs || (a.entityId < b.entityId ? -1 : 1));
  return samples;
}
