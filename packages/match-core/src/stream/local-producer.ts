import { fnv1aHex } from '../reducer/metric-separation';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { envelopeIdFor, STREAM_CONTRACT_VERSION, type StreamEnvelope } from './wire';

/**
 * KYN-13 — the LOCAL streaming producer (genuinely asynchronous).
 *
 * Replays the committed `synthetic-derby-01` fixture through a real async
 * transport with wall-clock pacing — it is NOT a timer inventing fictional
 * scores/positions: every emitted envelope is a verbatim committed source
 * record (original event/frame ids, absolute match-relative timestamps,
 * original coordinates, provenance and seed intact).
 *
 * Ordering: source-time order (tracking ticks interleaved with events by
 * their match timestamps) — ARRIVAL order is explicitly not event order
 * (docs/04), and the chaos controls can violate arrival further.
 *
 * Chaos profile: deterministic (seeded PRNG) duplicate / delay-reorder /
 * drop-frame / disconnect windows for red-team scenarios. Source vs arrival
 * time distinction is preserved: `emittedAt` (wall clock) is separate from
 * the envelope's match timestamps.
 */

export interface ProducerChaos {
  /** Probability an envelope is re-emitted immediately (at-least-once). */
  readonly duplicateRate?: number;
  /** Probability an envelope is held back to arrive after the next one. */
  readonly reorderRate?: number;
  /** Probability a tracking envelope is dropped entirely (missing frames). */
  readonly dropTrackingRate?: number;
  /** [fromMs, toMs] windows during which the transport "disconnects":
   *  envelopes inside a window are buffered and flushed on reconnect. */
  readonly disconnectWindowsMs?: readonly (readonly [number, number])[];
  /** Deterministic PRNG seed for reproducible chaos. */
  readonly seed?: number;
}

export interface ProducerOptions {
  readonly matchId: string;
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
  /** Playback speed multiplier (1×, 2×, 4×…). Default 1. */
  readonly speed?: number;
  readonly chaos?: ProducerChaos;
  /** Wall-clock ms to pace one source ms (overrides speed; for tests). */
  readonly msPerSourceMs?: number;
}

/** A source-order stream item with its match timestamp. */
interface SourceItem {
  readonly atMs: number;
  readonly envelope: StreamEnvelope;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LocalFixtureProducer {
  private readonly items: readonly SourceItem[];
  private readonly rng: () => number;
  private readonly speed: number;
  private readonly msPerSourceMs: number;
  private readonly chaos: Required<
    Pick<ProducerChaos, 'duplicateRate' | 'reorderRate' | 'dropTrackingRate'>
  >;
  private readonly disconnectWindows: readonly (readonly [number, number])[];
  private started = false;
  private stopped = false;
  /** Callback invoked with each emitted batch (arrival-order). */
  private sink: ((batch: readonly StreamEnvelope[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disconnected = false;
  private readonly disconnectEvents: readonly { atMs: number; kind: 'disconnect' | 'reconnect' }[];

  constructor(private readonly options: ProducerOptions) {
    this.rng = mulberry32(options.chaos?.seed ?? 24017);
    this.speed = options.speed ?? 1;
    this.msPerSourceMs = options.msPerSourceMs ?? 1 / this.speed;
    this.chaos = {
      duplicateRate: options.chaos?.duplicateRate ?? 0,
      reorderRate: options.chaos?.reorderRate ?? 0,
      dropTrackingRate: options.chaos?.dropTrackingRate ?? 0,
    };
    this.disconnectWindows = options.chaos?.disconnectWindowsMs ?? [];

    const envelopes: SourceItem[] = [];
    const seenEventIds = new Set<string>();
    for (const event of options.events) {
      // Revisions of one identity stream in revision order (duplicates of
      // the SAME revision carry identical content — the worker dedupes).
      if (
        seenEventIds.has(`${event.providerId}|${event.eventId}|${String(event.sourceRevision)}`)
      ) {
        continue;
      }
      seenEventIds.add(`${event.providerId}|${event.eventId}|${String(event.sourceRevision)}`);
      envelopes.push({
        atMs: event.occurredAtMs,
        envelope: envelopeForEvent(options.matchId, event, this.rng),
      });
    }
    const seenSamples = new Set<string>();
    for (const sample of options.tracking) {
      const key = `${sample.entityId}|${String(sample.sampleTimeMs)}|${String(sample.xM)},${String(sample.yM)}`;
      if (seenSamples.has(key)) continue;
      seenSamples.add(key);
      envelopes.push({
        atMs: sample.sampleTimeMs,
        envelope: envelopeForTracking(options.matchId, sample, this.rng),
      });
    }
    envelopes.sort((a, b) => a.atMs - b.atMs || orderKey(a.envelope) - orderKey(b.envelope));

    // Disconnect timeline (source-time keyed).
    const disconnectEvents: { atMs: number; kind: 'disconnect' | 'reconnect' }[] = [];
    for (const [fromMs, toMs] of this.disconnectWindows) {
      disconnectEvents.push({ atMs: fromMs, kind: 'disconnect' });
      disconnectEvents.push({ atMs: toMs, kind: 'reconnect' });
    }
    disconnectEvents.sort((a, b) => a.atMs - b.atMs);
    this.disconnectEvents = disconnectEvents;

    this.items = envelopes;
  }

  get envelopeCount(): number {
    return this.items.length;
  }

  /** Start emitting into the sink. Returns a stop() handle. */
  start(sink: (batch: readonly StreamEnvelope[]) => void): () => void {
    if (this.started) throw new Error('producer already started');
    this.started = true;
    this.sink = sink;
    void this.run();
    return () => {
      this.stopped = true;
      if (this.timer !== null) clearTimeout(this.timer);
    };
  }

  private async run(): Promise<void> {
    // Group items by source tick (same atMs ⇒ one batch) — the natural
    // arrival granularity of a 10 Hz tracking feed.
    const groups: { atMs: number; envelopes: StreamEnvelope[] }[] = [];
    for (const item of this.items) {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.atMs === item.atMs) {
        last.envelopes.push(item.envelope);
      } else {
        groups.push({ atMs: item.atMs, envelopes: [item.envelope] });
      }
    }

    let previousMs: number | null = null;
    let holdback: StreamEnvelope[] = []; // reorder chaos
    let flushOnReconnect: StreamEnvelope[] = []; // disconnect buffering

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        this.timer = setTimeout(resolve, Math.max(0, ms));
      });

    for (const group of groups) {
      if (this.stopped) return;
      const pacing = previousMs === null ? 60 : (group.atMs - previousMs) * this.msPerSourceMs;
      // Disconnect transitions: pause emitting across the window (the
      // transport is down), buffering envelopes like a real dead link.
      for (const transition of this.disconnectEvents) {
        if (transition.atMs > (previousMs ?? -1) && transition.atMs <= group.atMs) {
          if (transition.kind === 'disconnect') {
            this.disconnected = true;
          } else {
            this.disconnected = false;
          }
        }
      }
      await sleep(pacing);
      if (this.stopped) return;
      previousMs = group.atMs;

      const out: StreamEnvelope[] = [];
      for (const envelope of group.envelopes) {
        if (envelope.kind === 'tracking' && this.rng() < this.chaos.dropTrackingRate) {
          continue; // missing frame: never fabricated downstream
        }
        out.push(envelope);
        if (this.rng() < this.chaos.duplicateRate) {
          out.push(envelope); // at-least-once redelivery
        }
      }
      // Reorder chaos: hold this batch's LAST envelope for the next batch.
      if (out.length > 0 && this.rng() < this.chaos.reorderRate) {
        const held = out.pop()!;
        out.push(...holdback);
        holdback = [held];
      } else {
        out.push(...holdback);
        holdback = [];
      }

      if (this.disconnected) {
        flushOnReconnect.push(...out);
      } else if (flushOnReconnect.length > 0) {
        // Reconnected: buffered envelopes flush BEFORE the new batch
        // (at-least-once, arrival order ≠ event order — reducer handles it).
        flushOnReconnect.push(...out);
        const batch = flushOnReconnect;
        flushOnReconnect = [];
        this.sink?.(batch);
      } else if (out.length > 0) {
        this.sink?.(out);
      }
    }
    if (!this.stopped && holdback.length > 0) this.sink?.(holdback);
  }
}

function orderKey(envelope: StreamEnvelope): number {
  return envelope.kind === 'event' ? 0 : 1;
}

function envelopeForEvent(matchId: string, event: MatchEvent, rng: () => number): StreamEnvelope {
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    envelopeId: envelopeIdFor(
      matchId,
      'event',
      `${event.providerId}/${event.eventId}/r${String(event.sourceRevision)}`,
    ),
    matchId,
    kind: 'event',
    event,
    emittedAt: Date.now() + Math.floor(rng() * 2),
    traceId: traceIdFor(matchId, event.occurredAtMs, event.eventId),
  };
}

function envelopeForTracking(
  matchId: string,
  sample: TrackingSample,
  rng: () => number,
): StreamEnvelope {
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    envelopeId: envelopeIdFor(
      matchId,
      'tracking',
      `${sample.entityId}/${String(sample.sampleTimeMs)}`,
    ),
    matchId,
    kind: 'tracking',
    tracking: sample,
    emittedAt: Date.now() + Math.floor(rng() * 2),
    traceId: traceIdFor(matchId, sample.sampleTimeMs, sample.entityId),
  };
}

function traceIdFor(matchId: string, atMs: number, key: string): string {
  return `trc-${fnv1aHex(canonicalJsonStringify({ matchId, atMs, key }))}`;
}
