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
 * v2 (review gates): the snapshot now carries the FULL canonical tracking
 * samples (lossless — the interned scene format lost confidence precision,
 * source-frame ids and reconstruction disclosures), and deltas carry
 * `removedTracking` tombstone removals plus replacement-by-identity event
 * corrections. Incompatible with v1 peers by design — they fail closed.
 *
 * Versioning law (KYN-12 gate-3 lesson): event-envelope `revisionCount`
 * does NOT move when only tracking coordinates change, so the authoritative
 * state version is a CONTENT FINGERPRINT over the whole accepted set —
 * every normalized accepted field (see acceptedSetFingerprint) — so any
 * materially different corpus necessarily has a different version.
 * Delivery carries a monotonic `seq` per stream session INDEPENDENT of the
 * content version AND of snapshot issuance (snapshots are read-only with
 * respect to the broadcast sequence), so clients detect real gaps
 * deterministically and never resynchronize because another viewer joined.
 */

export const STREAM_CONTRACT_VERSION = 'kyneloom-live-wire-v2';

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

/** A tombstoned tracking sample a delta REMOVES from the accepted corpus. */
export interface RemovedTrackingKey {
  readonly entityId: string;
  readonly sampleTimeMs: number;
}

/** Server→client frames over the delivery transport (SSE today, Web PubSub when provisioned). */
export type LiveFrame =
  | {
      readonly type: 'snapshot';
      readonly matchId: string;
      readonly sessionId: string;
      /** Content fingerprint of the accepted set this snapshot contains. */
      readonly stateVersion: string;
      /** Current broadcast position (read-only: snapshots NEVER advance it). */
      readonly seq: number;
      readonly sourceRevision: number;
      readonly matchTimeMs: number;
      readonly traceId: string;
      readonly acceptedEvents: readonly MatchEvent[];
      /** FULL canonical tracking samples — lossless (client verifies the
       *  fingerprint over exactly what the server fingerprinted). */
      readonly tracking: readonly TrackingSample[];
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
      /** New accepted event envelopes. Corrections REPLACE the superseded
       *  revision in the sender's accepted set; clients apply the same
       *  replacement-by-identity ((providerId, eventId) — the reducer's
       *  acceptedEvents law), NOT append. */
      readonly newEvents: readonly MatchEvent[];
      /** New accepted tracking samples (append-only ticks). */
      readonly newTracking: readonly TrackingSample[];
      /** Tombstoned samples REMOVED from the accepted corpus by conflict
       *  rules (client must remove them before applying newTracking). */
      readonly removedTracking: readonly RemovedTrackingKey[];
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

// ---------------------------------------------------------------------------
// Content fingerprint — THE state version.

/**
 * Fingerprint over the FULL normalized accepted set (review gate C): the
 * canonical JSON of every accepted event (identity + team/actor/attributes/
 * provenance/correction links) and every accepted tracking sample
 * (coordinates + confidence + visibility + origin + source frame +
 * reconstruction disclosure). Distinct accepted corpora — including
 * same-coordinates-different-assurance — necessarily produce distinct
 * versions; identical sets in any array order produce the same version
 * (stable sorts). Serialization is the contracts' canonical JSON (sorted
 * keys), so it is deterministic and bounded by the accepted corpus itself.
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
    .map((event) => canonicalJsonStringify(event));
  const trackingParts = [...tracking]
    .sort((a, b) => a.sampleTimeMs - b.sampleTimeMs || (a.entityId < b.entityId ? -1 : 1))
    .map((sample) => canonicalJsonStringify(sample));
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
    if (frame.removedTracking !== undefined) {
      if (!Array.isArray(frame.removedTracking)) return null;
      for (const key of frame.removedTracking) {
        if (
          typeof key !== 'object' ||
          key === null ||
          typeof (key as RemovedTrackingKey).entityId !== 'string' ||
          !Number.isInteger((key as RemovedTrackingKey).sampleTimeMs)
        ) {
          return null;
        }
      }
    }
    return frame as unknown as LiveFrame;
  }
  if (frame.type === 'status') {
    if (typeof frame.status !== 'string' || typeof frame.detail !== 'string') return null;
    return frame as unknown as LiveFrame;
  }
  return null;
}
