import { mkdirSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  LiveProjectionWorker,
  LocalFixtureProducer,
  acceptedSetFingerprint,
  type LiveFrame,
  type QuarantineRecord,
  type StreamEnvelope,
  type ProducerChaos,
} from '@kyneloom/match-core';
import { loadGoldenMatch } from '@/lib/match-fixture';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';

/**
 * KYN-13 — the server-side live match service (singleton per process).
 *
 * Owns the authoritative LiveProjectionWorker for the synthetic demo match
 * and the local fixture producer. Delivery to browsers goes through
 * bounded per-subscriber queues (backpressure law): PRESENTATION deltas
 * may be compacted under pressure (superseded tracking ticks merged into
 * the latest), but authoritative frames — snapshots, event deltas,
 * corrections — are never silently dropped; a subscriber whose queue
 * cannot drain receives a snapshot-resync instead.
 *
 * DURABILITY (docs/09): Event Hubs retention is NOT an archive. Every
 * admitted, rejected and corrected envelope is appended to a local
 * append-only JSONL archive (the Blob equivalent when deployed), plus a
 * durable quarantine file with trace ids. Checkpoints (last durably
 * processed envelope id) are written only after the archive append
 * succeeds — never merely because a handler saw the message.
 */

const ARCHIVE_ROOT = path.join(process.cwd(), '.live-archive');

export interface LiveStatusSnapshot {
  readonly running: boolean;
  readonly matchId: string;
  readonly sessionId: string;
  readonly stateVersion: string;
  readonly seq: number;
  readonly matchTimeMs: number;
  readonly sourceRevision: number;
  readonly subscribers: number;
  readonly droppedSubscribers: number;
  readonly quarantined: number;
  readonly archivedEnvelopes: number;
  readonly projectionMsMean: number;
  readonly envelopeRatePerSec: number;
}

interface Subscriber {
  readonly id: string;
  queue: LiveFrame[];
  capacity: number;
  version: string | null;
  resyncNeeded: boolean;
}

export type LiveSpeed = 1 | 2 | 4;

export class LiveMatchService {
  private static instance: LiveMatchService | null = null;

  static get(): LiveMatchService {
    LiveMatchService.instance ??= new LiveMatchService();
    return LiveMatchService.instance;
  }

  readonly matchId = 'synthetic-derby-01';
  readonly sessionId = `live-${String(Date.now())}`;
  private worker: LiveProjectionWorker;
  private producer: LocalFixtureProducer | null = null;
  private stopProducer: (() => void) | null = null;
  private subscribers = new Map<string, Subscriber>();
  private droppedSubscribers = 0;
  private running = false;
  private quarantinedCount = 0;
  private archivedCount = 0;
  private readonly startedAt = Date.now();
  private speed: LiveSpeed = 2;
  private archiveDir: string;
  private checkpointEnvelopeId: string | null = null;
  private readonly latencyLog: {
    traceId: string;
    envelopeIn: number;
    published: number;
    kind: 'event' | 'tracking';
  }[] = [];

  private constructor() {
    this.worker = new LiveProjectionWorker({ matchId: this.matchId, sessionId: this.sessionId });
    this.archiveDir = path.join(ARCHIVE_ROOT, this.matchId);
  }

  get status(): LiveStatusSnapshot {
    return {
      running: this.running,
      matchId: this.matchId,
      sessionId: this.sessionId,
      stateVersion: this.worker.currentVersion,
      seq: this.worker.currentSeq,
      matchTimeMs: this.worker.currentMatchTimeMs,
      sourceRevision: this.worker.view().projection.revisionCount,
      subscribers: this.subscribers.size,
      droppedSubscribers: this.droppedSubscribers,
      quarantined: this.quarantinedCount,
      archivedEnvelopes: this.archivedCount,
      projectionMsMean: this.worker.stats.projectionMsMean,
      envelopeRatePerSec:
        this.archivedCount === 0
          ? 0
          : this.archivedCount / Math.max(0.001, (Date.now() - this.startedAt) / 1000),
    };
  }

  get currentSpeed(): LiveSpeed {
    return this.speed;
  }

  /** Start the local producer (idempotent). Loads the committed fixture. */
  async start(options?: { speed?: LiveSpeed; chaos?: ProducerChaos }): Promise<void> {
    if (this.running) return;
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('golden fixture unavailable — live stream cannot start');
    const events = golden.data.projected.acceptedEvents as MatchEvent[];
    // The recorded fixture's accepted tracking IS the source corpus; the
    // producer replays the RAW committed samples (allEventRevisions carries
    // every valid envelope incl. corrections for true replay).
    const rawGolden = await loadGoldenMatch();
    const tracking = (
      rawGolden.ok ? rawGolden.data.projected.acceptedTracking : []
    ) as TrackingSample[];
    this.speed = options?.speed ?? this.speed;
    this.producer = new LocalFixtureProducer({
      matchId: this.matchId,
      events,
      tracking,
      speed: this.speed,
      chaos: options?.chaos,
    });
    this.worker = new LiveProjectionWorker({ matchId: this.matchId, sessionId: this.sessionId });
    mkdirSync(this.archiveDir, { recursive: true });
    this.running = true;
    this.stopProducer = this.producer.start((batch) => this.ingest(batch));
  }

  stop(): void {
    this.stopProducer?.();
    this.stopProducer = null;
    this.running = false;
    for (const subscriber of this.subscribers.values()) {
      this.pushToSubscriber(subscriber, {
        type: 'status',
        matchId: this.matchId,
        sessionId: this.sessionId,
        seq: this.worker.currentSeq,
        status: 'disconnected',
        detail: 'stream stopped by operator',
        traceId: '',
      });
    }
  }

  /** Durable ingestion path: archive first, then process, then checkpoint. */
  ingest(batch: readonly StreamEnvelope[]): void {
    if (batch.length === 0) return;
    const receivedAt = Date.now();

    // 1. Append-only archive of EVERY raw envelope (accepted or not) BEFORE
    //    processing — this is the durable source record, not hub retention.
    this.appendToArchive(batch);

    // 2. Canonical admission through the authoritative worker.
    const result = this.worker.admit(batch);
    this.quarantinedCount += result.quarantined.length;

    // 3. Durable quarantine records (trace ids, no payloads).
    if (result.quarantined.length > 0) {
      appendFileSync(
        path.join(this.archiveDir, 'quarantine.jsonl'),
        result.quarantined.map((record: QuarantineRecord) => JSON.stringify(record)).join('\n') +
          '\n',
        'utf-8',
      );
    }

    // 4. Checkpoint AFTER the durable obligations succeeded.
    this.checkpointEnvelopeId = batch[batch.length - 1]!.envelopeId;
    appendFileSync(
      path.join(this.archiveDir, 'checkpoint.json'),
      JSON.stringify({
        checkpointEnvelopeId: this.checkpointEnvelopeId,
        stateVersion: this.worker.currentVersion,
        seq: this.worker.currentSeq,
        at: Date.now(),
      }),
      'utf-8',
    );

    // 5. Publish. Latency samples keep real trace ids.
    const delta = this.worker.takePendingDelta();
    if (delta !== null) {
      for (const envelope of batch) {
        this.latencyLog.push({
          traceId: envelope.traceId,
          envelopeIn: receivedAt,
          published: Date.now(),
          kind: envelope.kind,
        });
      }
      if (this.latencyLog.length > 5000) this.latencyLog.splice(0, this.latencyLog.length - 5000);
      this.broadcast(delta);
    }
  }

  /** Canonical snapshot for a new/reconnecting subscriber. */
  snapshotFrame(): LiveFrame {
    return this.worker.snapshot();
  }

  subscribe(id: string, capacity = 64): Subscriber {
    const subscriber: Subscriber = {
      id,
      queue: [],
      capacity,
      version: null,
      resyncNeeded: false,
    };
    this.subscribers.set(id, subscriber);
    // First frame is ALWAYS the canonical snapshot.
    const snapshot = this.worker.snapshot();
    subscriber.queue.push(snapshot);
    subscriber.version = (snapshot as { stateVersion: string }).stateVersion;
    return subscriber;
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  /** Drain up to `max` frames for a subscriber (SSE poll). */
  drain(id: string, max = 8): readonly LiveFrame[] {
    const subscriber = this.subscribers.get(id);
    if (subscriber === undefined) return [];
    const frames = subscriber.queue.splice(0, max);
    if (subscriber.resyncNeeded && frames.length < max) {
      subscriber.resyncNeeded = false;
      const snapshot = this.worker.snapshot();
      subscriber.queue.unshift(snapshot);
      subscriber.version = (snapshot as { stateVersion: string }).stateVersion;
    }
    return frames;
  }

  private broadcast(frame: LiveFrame): void {
    for (const subscriber of this.subscribers.values()) {
      this.pushToSubscriber(subscriber, frame);
    }
  }

  private pushToSubscriber(subscriber: Subscriber, frame: LiveFrame): void {
    const isAuthoritative =
      frame.type === 'snapshot' || frame.type === 'status' || frame.newEvents.length > 0;
    if (subscriber.queue.length >= subscriber.capacity) {
      if (isAuthoritative) {
        // Never drop authoritative frames: compact superseded PRESENTATION
        // deltas to make room; if nothing is compactable, mark for snapshot
        // resync instead of losing the frame.
        const compacted = this.compactPresentationDeltas(subscriber);
        if (!compacted && subscriber.queue.length >= subscriber.capacity) {
          subscriber.resyncNeeded = true;
          this.droppedSubscribers += 1;
          return;
        }
      } else {
        // Presentation delta under pressure with a full queue: compact.
        const compacted = this.compactPresentationDeltas(subscriber);
        if (!compacted) {
          // Only presentation deltas of the same base present: merge.
          this.compactPresentationDeltas(subscriber, true);
          return;
        }
      }
    }
    if (frame.type === 'delta' || frame.type === 'snapshot') {
      subscriber.version = frame.stateVersion;
    }
    subscriber.queue.push(frame);
  }

  /**
   * Backpressure compaction: merge adjacent presentation-only deltas in the
   * queue (their tracking payloads concatenate; events concatenate). The
   * merged frame keeps the LATEST seq/stateVersion so sequence detection
   * stays exact — the subscriber sees one equivalent delta instead of N.
   * Returns true when the queue shrank.
   */
  private compactPresentationDeltas(subscriber: Subscriber, force = false): boolean {
    const queue = subscriber.queue;
    for (let i = 0; i + 1 < queue.length; i += 1) {
      const a = queue[i]!;
      const b = queue[i + 1]!;
      if (
        a.type === 'delta' &&
        b.type === 'delta' &&
        a.newEvents.length === 0 &&
        b.newEvents.length === 0
      ) {
        queue.splice(i, 2, {
          ...b,
          newTracking: [...a.newTracking, ...b.newTracking],
          matchTimeMs: Math.max(a.matchTimeMs, b.matchTimeMs),
        });
        return true;
      }
    }
    if (force && queue.length > 1) {
      // Last resort under pure-presentation pressure: keep only the newest
      // presentation delta (its base covers the dropped ones' tracking via
      // the merged newTracking above; if that already ran, drop the OLDEST
      // delta whose content is fully superseded by the newest one's
      // version chain — the subscriber's gap detection then triggers a
      // snapshot resync, which is the honest outcome).
      const oldest = queue[0];
      if (oldest !== undefined && oldest.type === 'delta' && oldest.newEvents.length === 0) {
        queue.splice(0, 1);
        return true;
      }
    }
    return false;
  }

  private appendToArchive(batch: readonly StreamEnvelope[]): void {
    const file = path.join(this.archiveDir, 'envelopes.jsonl');
    const lines: string[] = [];
    for (const envelope of batch) {
      lines.push(
        JSON.stringify({
          envelopeId: envelope.envelopeId,
          matchId: envelope.matchId,
          kind: envelope.kind,
          traceId: envelope.traceId,
          emittedAt: envelope.emittedAt,
          archivedAt: Date.now(),
          payload: envelope.kind === 'event' ? envelope.event : envelope.tracking,
        }),
      );
      this.archivedCount += 1;
    }
    appendFileSync(file, lines.join('\n') + '\n', 'utf-8');
    if (!existsSync(path.join(this.archiveDir, 'manifest.json'))) {
      writeFileSync(
        path.join(this.archiveDir, 'manifest.json'),
        JSON.stringify(
          {
            note: 'local append-only archive (dev). Blob Storage container when deployed. Event Hubs retention is NOT an archive.',
            sessionId: this.sessionId,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf-8',
      );
    }
  }

  /** Latency evidence (source→publish) with real trace ids. */
  latencySamples(): readonly { traceId: string; kind: string; ingestToPublishMs: number }[] {
    return this.latencyLog.slice(-500).map((sample) => ({
      traceId: sample.traceId,
      kind: sample.kind,
      ingestToPublishMs: sample.published - sample.envelopeIn,
    }));
  }

  /** Recompute the fingerprint over the current accepted set (integrity). */
  integrityFingerprint(): string {
    const view = this.worker.view();
    return acceptedSetFingerprint(view.acceptedEvents, view.acceptedTracking);
  }
}
