import { canonicalJsonStringify } from '@kyneloom/contracts';
import { fnv1aHex } from '../reducer/metric-separation';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';

/**
 * KYN-13 — the canonical wire contract for the live path.
 *
 * ONE incoming message shape for every transport (local async, Azure Event
 * Hubs): a `StreamEnvelope` carrying either a canonical event envelope or a
 * tracking sample, plus transport metadata. Everything downstream —
 * validation, the authoritative projection worker, snapshot/delta building
 * and client synchronization — speaks only this contract, so the local
 * adapter and the Azure adapter exercise IDENTICAL semantics (docs/04
 * fast path; docs/09 Event Hubs policy).
 *
 * Versioning law (KYN-12 gate-3 lesson): event-envelope `revisionCount`
 * does NOT move when only tracking coordinates change, so the authoritative
 * state version is a CONTENT FINGERPRINT over the whole accepted set
 * (canonical events + canonical tracking) — a tracking-only correction
 * necessarily changes it. Delivery carries a monotonic `seq` per stream
 * session INDEPENDENT of the content version, so clients detect gaps
 * deterministically.
 */

export const STREAM_CONTRACT_VERSION = 'kyneloom-live-wire-v1';

/** Wire message admitted into a transport (server→worker and replay). */
export interface StreamEnvelope {
  readonly contractVersion: typeof STREAM_CONTRACT_VERSION;
  /** Producer-assigned deterministic id (identity for at-least-once dedupe). */
  readonly envelopeId: string;
  readonly matchId: string;
  readonly kind: 'event' | 'tracking';
  readonly event?: MatchEvent;
  readonly tracking?: TrackingSample;
  /** Producer wall-clock when the envelope was emitted (ms epoch). */
  readonly emittedAt: number;
  /** End-to-end correlation id carried into every downstream record. */
  readonly traceId: string;
}

/** Server→client frames over the delivery transport (SSE today, Web PubSub when provisioned). */
export type LiveFrame =
  | {
      readonly type: 'snapshot';
      readonly matchId: string;
      readonly sessionId: string;
      /** Content fingerprint of the accepted set this snapshot contains. */
      readonly stateVersion: string;
      /** Monotonic delivery sequence (resets only on worker restart, disclosed). */
      readonly seq: number;
      readonly sourceRevision: number;
      readonly matchTimeMs: number;
      readonly traceId: string;
      readonly acceptedEvents: readonly MatchEvent[];
      /** Interned compact tracking — the same shape scene-client rehydrates. */
      readonly tracking: readonly StreamTrackingTrack[];
      readonly trackingAvailable: boolean;
    }
  | {
      readonly type: 'delta';
      readonly matchId: string;
      readonly sessionId: string;
      /** Version this delta REQUIRES as its base (client must match). */
      readonly baseVersion: string;
      /** Content fingerprint after applying this delta. */
      readonly stateVersion: string;
      readonly seq: number;
      readonly sourceRevision: number;
      readonly matchTimeMs: number;
      readonly traceId: string;
      /** New accepted event envelopes (includes corrections). */
      readonly newEvents: readonly MatchEvent[];
      /** New accepted tracking samples (append-only ticks). */
      readonly newTracking: readonly TrackingSample[];
      readonly trackingAvailable: boolean;
    }
  | {
      readonly type: 'status';
      readonly matchId: string;
      readonly sessionId: string;
      readonly seq: number;
      readonly status: LiveConnectionStatus;
      readonly detail: string;
      readonly traceId: string;
    };

export type LiveConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'resynchronizing' | 'disconnected';

/** Interned tracking track (matches the scene-data wire format). */
export interface StreamTrackingTrack {
  readonly entityId: string;
  readonly t: readonly number[];
  readonly xyz: readonly number[];
  readonly o: readonly number[];
  readonly v: readonly number[];
  readonly c: readonly number[];
  readonly f: readonly number[];
}

// ---------------------------------------------------------------------------
// Content fingerprint — THE state version.

/**
 * Fingerprint over the full accepted set. Canonical JSON of sorted event
 * identities/revisions + sorted (time, entity) sample coordinates. Any
 * accepted change — event, correction, or tracking-only — flips it.
 */
export function acceptedSetFingerprint(
  events: readonly MatchEvent[],
  tracking: readonly TrackingSample[],
): string {
  const eventParts = [...events]
    .sort(
      (a, b) =>
        a.occurredAtMs - b.occurredAtMs ||
        (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) ||
        a.sourceRevision - b.sourceRevision,
    )
    .map(
      (event) =>
        `${event.providerId}/${event.eventId}@r${String(event.sourceRevision)}:${String(event.occurredAtMs)}:${event.kind}`,
    );
  const trackingParts = [...tracking]
    .sort((a, b) => a.sampleTimeMs - b.sampleTimeMs || (a.entityId < b.entityId ? -1 : 1))
    .map(
      (sample) =>
        `${sample.entityId}@${String(sample.sampleTimeMs)}:${String(sample.xM)},${String(sample.yM)},${String(sample.zM)}`,
    );
  return fnv1aHex(
    canonicalJsonStringify({
      contractVersion: STREAM_CONTRACT_VERSION,
      events: eventParts,
      tracking: trackingParts,
    }),
  );
}

/** Deterministic envelope id for a fixture envelope (stable across replays). */
export function envelopeIdFor(matchId: string, kind: 'event' | 'tracking', key: string): string {
  return `env-${fnv1aHex(canonicalJsonStringify({ matchId, kind, key }))}`;
}

/** Runtime validation for arbitrary incoming wire frames (fail-closed). */
export function validateLiveFrame(value: unknown): LiveFrame | null {
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type === 'snapshot') {
    if (
      typeof frame.matchId !== 'string' ||
      typeof frame.stateVersion !== 'string' ||
      !Number.isInteger(frame.seq) ||
      !Array.isArray(frame.acceptedEvents) ||
      !Array.isArray(frame.tracking) ||
      typeof frame.trackingAvailable !== 'boolean'
    ) {
      return null;
    }
    return frame as unknown as LiveFrame;
  }
  if (frame.type === 'delta') {
    if (
      typeof frame.baseVersion !== 'string' ||
      typeof frame.stateVersion !== 'string' ||
      !Number.isInteger(frame.seq) ||
      !Array.isArray(frame.newEvents) ||
      !Array.isArray(frame.newTracking) ||
      typeof frame.trackingAvailable !== 'boolean'
    ) {
      return null;
    }
    return frame as unknown as LiveFrame;
  }
  if (frame.type === 'status') {
    if (typeof frame.status !== 'string' || typeof frame.detail !== 'string') return null;
    return frame as unknown as LiveFrame;
  }
  return null;
}
