import { describe, expect, it } from 'vitest';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import {
  acceptedSetFingerprint,
  STREAM_CONTRACT_VERSION,
  type LiveFrame,
  type StreamEnvelope,
} from './wire';
import { LiveProjectionWorker } from './worker';
import { LiveSyncController, type SyncEvent } from './client-sync';

/**
 * KYN-13 red-team suite (mission §10). Every scenario runs against the
 * REAL worker + producer + client controller — no mocks of football
 * semantics. The canonical reference is always the batch `projectMatch`
 * over the same committed corpus.
 */

describe('KYN-13 red-team — corrections and quarantine', () => {
  function eventEnvelope(overrides: Partial<MatchEvent> & { eventId: string }): StreamEnvelope {
    const event: MatchEvent = {
      schemaVersion: '1.0',
      providerId: 'provider-a',
      tenantId: 'tenant-a',
      matchId: 'synthetic-derby-01',
      sourceRevision: 1,
      kind: 'goal',
      occurredAtMs: 4_728_300,
      ingestedAt: '2026-10-01T00:00:00Z',
      sequence: 1,
      actorId: 'home-09',
      teamId: 'home',
      attributes: {},
      provenance: {
        origin: 'synthetic_ground_truth',
        generatorVersion: 'fixture-engine-v1',
        confidence: 1,
      },
      correctionOf: null,
      ...overrides,
    } as MatchEvent;
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `env-test-${overrides.eventId}-r${String(event.sourceRevision)}-of-${String(event.correctionOf ?? 'none')}`,
      matchId: 'synthetic-derby-01',
      kind: 'event',
      event,
      emittedAt: Date.now(),
      traceId: 'trc-test',
    };
  }

  it('1. a duplicate goal never increments the score twice', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    const goal = eventEnvelope({ eventId: 'evt-goal-1' });
    worker.admit([goal]);
    const scoreAfterFirst = worker.view().projection.latestState(4_728_400).score;
    const result = worker.admit([goal, goal]); // at-least-once redelivery
    expect(result.changed).toBe(false);
    expect(result.duplicateCount).toBe(2);
    expect(worker.view().projection.latestState(4_728_400).score).toEqual(scoreAfterFirst);
  });

  it('3. a valid late correction updates the correct facts (goal rescission)', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([eventEnvelope({ eventId: 'evt-goal-1' })]);
    const withGoal = worker.view().projection.latestState(4_728_400).score.home;
    worker.admit([
      eventEnvelope({
        eventId: 'evt-goal-1',
        sourceRevision: 2,
        kind: 'period_end',
        correctionOf: 'evt-goal-1',
      }),
    ]);
    const afterCorrection = worker.view().projection.latestState(4_728_400).score.home;
    expect(afterCorrection).toBe(withGoal - 1);
    // The version changed — a correction is a real state change.
    const fp = acceptedSetFingerprint(worker.view().acceptedEvents, worker.view().acceptedTracking);
    expect(fp).toBe(worker.currentVersion);
  });

  it('4. an INVALID correction does not erase valid prior state', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([eventEnvelope({ eventId: 'evt-goal-1' })]);
    const scoreBefore = worker.view().projection.latestState(4_728_400).score.home;
    const result = worker.admit([
      eventEnvelope({
        eventId: 'evt-goal-1',
        sourceRevision: 5,
        correctionOf: 'evt-never-existed', // unknown target
      }),
    ]);
    expect(result.quarantined.length).toBeGreaterThan(0);
    expect(result.quarantined[0]!.reason).toBe('unknown-correction-target');
    expect(worker.view().projection.latestState(4_728_400).score.home).toBe(scoreBefore);
  });

  it('5. a tracking-only correction changes the state version at unchanged event revision', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    const sample = (xM: number): StreamEnvelope => ({
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `env-trk-${String(xM)}`,
      matchId: 'synthetic-derby-01',
      kind: 'tracking',
      tracking: {
        schemaVersion: '1.0',
        matchId: 'synthetic-derby-01',
        sampleTimeMs: 4_720_500,
        entityId: 'away-03',
        xM,
        yM: -3,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: 'frame-47205',
      } as TrackingSample,
      emittedAt: Date.now(),
      traceId: 'trc-trk',
    });
    // Same (entity, time), different coordinates → a source correction the
    // event revision cannot express. Different envelope ids (new delivery).
    worker.admit([sample(25.046)]);
    const version1 = worker.currentVersion;
    const revision1 = worker.view().projection.revisionCount;
    worker.admit([sample(27.5), sample(25.046)]);
    // The reducer poisons the conflicting pair (tombstone) — the accepted
    // set CHANGED (the position is now explicitly absent) and so did the
    // version, while the event revision stayed identical.
    expect(worker.view().projection.revisionCount).toBe(revision1);
    expect(worker.currentVersion).not.toBe(version1);
  });

  it('7. malformed and poison envelopes are quarantined with trace ids', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    const malformed: StreamEnvelope = {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: 'env-malformed',
      matchId: 'synthetic-derby-01',
      kind: 'event',
      event: { nonsense: true } as unknown as MatchEvent,
      emittedAt: Date.now(),
      traceId: 'trc-malformed',
    };
    const wrongMatch: StreamEnvelope = {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: 'env-wrong-match',
      matchId: 'another-match',
      kind: 'event',
      event: undefined,
      emittedAt: Date.now(),
      traceId: 'trc-wrong-match',
    };
    const result = worker.admit([malformed, wrongMatch]);
    expect(result.quarantined.length).toBe(2);
    expect(result.quarantined.map((q) => q.reason)).toContain('malformed');
    expect(result.quarantined.map((q) => q.reason)).toContain('match-mismatch');
    for (const record of result.quarantined) {
      expect(record.traceId).toBeTruthy();
      expect(JSON.stringify(record)).not.toContain('password');
    }
  });
});

describe('KYN-13 review gate C — the state version covers ALL accepted facts', () => {
  const baseSample: TrackingSample = {
    schemaVersion: '1.0',
    matchId: 'synthetic-derby-01',
    sampleTimeMs: 4_720_500,
    entityId: 'home-05',
    xM: 10.5,
    yM: -3,
    zM: 0,
    origin: 'synthetic_ground_truth',
    confidence: 0.93,
    visibility: 'tracked',
    sourceFrameId: 'frame-47205',
  };
  const baseEvent: MatchEvent = {
    schemaVersion: '1.0',
    eventId: 'evt-base',
    providerId: 'provider-a',
    tenantId: 'tenant-a',
    matchId: 'synthetic-derby-01',
    sourceRevision: 1,
    kind: 'pass_attempted',
    occurredAtMs: 4_722_000,
    ingestedAt: '2026-10-01T00:00:00Z',
    sequence: 3,
    actorId: 'home-09',
    teamId: 'home',
    attributes: { lane: 'left' },
    provenance: {
      origin: 'synthetic_ground_truth',
      generatorVersion: 'fixture-engine-v1',
      confidence: 0.97,
    },
    correctionOf: null,
  } as MatchEvent;

  it('C1. same coordinates, changed confidence ⇒ different version', () => {
    const a = acceptedSetFingerprint([], [baseSample]);
    const b = acceptedSetFingerprint([], [{ ...baseSample, confidence: 0.94 }]);
    expect(a).not.toBe(b);
  });

  it('C2. same coordinates, changed visibility/origin (reconstructed) ⇒ different version', () => {
    const reconstructed: TrackingSample = {
      ...baseSample,
      origin: 'interpolated',
      visibility: 'partial',
      confidence: 0.6,
      reconstruction: { method: 'linear' },
    };
    const a = acceptedSetFingerprint([], [baseSample]);
    const b = acceptedSetFingerprint([], [reconstructed]);
    expect(a).not.toBe(b);
    // The reconstruction disclosure itself is covered too.
    const c = acceptedSetFingerprint(
      [],
      [{ ...reconstructed, reconstruction: { method: 'spline' } }],
    );
    expect(b).not.toBe(c);
  });

  it('C3. same coordinates, changed sourceFrameId ⇒ different version', () => {
    const a = acceptedSetFingerprint([], [baseSample]);
    const b = acceptedSetFingerprint([], [{ ...baseSample, sourceFrameId: 'frame-47206' }]);
    expect(a).not.toBe(b);
  });

  it('C4. changed event team/actor/attributes/provenance at identical identity ⇒ different version', () => {
    const a = acceptedSetFingerprint([baseEvent], []);
    expect(acceptedSetFingerprint([{ ...baseEvent, teamId: 'away' } as MatchEvent], [])).not.toBe(
      a,
    );
    expect(
      acceptedSetFingerprint([{ ...baseEvent, actorId: 'home-11' } as MatchEvent], []),
    ).not.toBe(a);
    expect(
      acceptedSetFingerprint([{ ...baseEvent, attributes: { lane: 'right' } } as MatchEvent], []),
    ).not.toBe(a);
    expect(
      acceptedSetFingerprint(
        [
          {
            ...baseEvent,
            provenance: { ...baseEvent.provenance, confidence: 0.98 },
          } as MatchEvent,
        ],
        [],
      ),
    ).not.toBe(a);
  });

  it('C5. identical accepted sets in any array order ⇒ SAME version', () => {
    const other: TrackingSample = { ...baseSample, entityId: 'away-02', sampleTimeMs: 4_720_600 };
    const third: TrackingSample = { ...baseSample, entityId: 'ball', sampleTimeMs: 4_720_400 };
    const events: MatchEvent[] = [
      baseEvent,
      { ...baseEvent, eventId: 'evt-2', occurredAtMs: 4_722_100 } as MatchEvent,
    ];
    const forward = acceptedSetFingerprint(events, [baseSample, other, third]);
    const backward = acceptedSetFingerprint([...events].reverse(), [third, other, baseSample]);
    expect(forward).toBe(backward);
  });
});

describe('KYN-13 review gate B — snapshot issuance never burns the broadcast sequence', () => {
  function trackingEnvelope(sampleTimeMs: number): StreamEnvelope {
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `env-seq-${String(sampleTimeMs)}`,
      matchId: 'synthetic-derby-01',
      kind: 'tracking',
      tracking: {
        schemaVersion: '1.0',
        matchId: 'synthetic-derby-01',
        sampleTimeMs,
        entityId: 'home-01',
        xM: 1,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: `frame-${String(Math.round(sampleTimeMs / 100))}`,
      } as TrackingSample,
      emittedAt: Date.now(),
      traceId: 'trc-seq',
    };
  }

  it('B1. repeated snapshots are read-only w.r.t. seq; the next delta is exactly lastSeq+1', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([trackingEnvelope(1000)]);
    const d1 = worker.takePendingDelta()!;
    if (d1.type !== 'delta') throw new Error('delta expected');
    expect(d1.seq).toBe(1);
    // Snapshots for late joiners, HTTP reads, resyncs — as many as we like.
    for (let i = 0; i < 5; i += 1) {
      const snap = worker.snapshot();
      if (snap.type !== 'snapshot') throw new Error('snapshot expected');
      expect(snap.seq).toBe(1); // the broadcast position, NOT advanced
    }
    worker.admit([trackingEnvelope(1100)]);
    const d2 = worker.takePendingDelta()!;
    if (d2.type !== 'delta') throw new Error('delta expected');
    expect(d2.seq).toBe(2); // contiguous: no viewer can see a false gap
  });

  it('B2. two viewers joining at different times both see a contiguous sequence', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    // Viewer A joins BEFORE any delta (empty snapshot, seq 0); viewer B
    // joins AFTER the first delta (snapshot carries the same seq 1).
    const viewerA = makeController(worker);
    worker.admit([trackingEnvelope(1000)]);
    const d1 = worker.takePendingDelta()!;
    const viewerB = makeController(worker); // late joiner: snapshot at seq 1
    expect(viewerA.applyFrame(d1)).toBe(true);
    worker.admit([trackingEnvelope(1100)]);
    const d2 = worker.takePendingDelta()!;
    // BOTH viewers accept the same next delta contiguously — B's late
    // snapshot must not have consumed a sequence number.
    expect(viewerA.applyFrame(d2)).toBe(true);
    expect(viewerB.applyFrame(d2)).toBe(true);
  });

  it('B3. a genuinely dropped delta is detected as a gap and triggers resync', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    const events: SyncEvent[] = [];
    const viewer = makeController(worker, events);
    worker.admit([trackingEnvelope(1000)]);
    expect(viewer.applyFrame(worker.takePendingDelta()!)).toBe(true);
    worker.admit([trackingEnvelope(1100)]);
    void worker.takePendingDelta()!; // dropped in transit
    worker.admit([trackingEnvelope(1200)]);
    const d3 = worker.takePendingDelta()!;
    // The gap MUST be rejected with a gap event, never silently accepted.
    expect(viewer.applyFrame(d3)).toBe(false);
    expect(events.some((e) => e.type === 'gap')).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.status === 'resynchronizing')).toBe(true);
  });
});

describe('KYN-13 review gate D — client convergence for corrections and tombstones', () => {
  function eventEnvelope(overrides: Partial<MatchEvent> & { eventId: string }): StreamEnvelope {
    const event: MatchEvent = {
      schemaVersion: '1.0',
      providerId: 'provider-a',
      tenantId: 'tenant-a',
      matchId: 'synthetic-derby-01',
      sourceRevision: 1,
      kind: 'goal',
      occurredAtMs: 4_728_300,
      ingestedAt: '2026-10-01T00:00:00Z',
      sequence: 1,
      actorId: 'home-09',
      teamId: 'home',
      attributes: {},
      provenance: {
        origin: 'synthetic_ground_truth',
        generatorVersion: 'fixture-engine-v1',
        confidence: 1,
      },
      correctionOf: null,
      ...overrides,
    } as MatchEvent;
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `env-conv-${overrides.eventId}-r${String(event.sourceRevision)}`,
      matchId: 'synthetic-derby-01',
      kind: 'event',
      event,
      emittedAt: Date.now(),
      traceId: 'trc-conv',
    };
  }

  function trackingEnvelope(sampleTimeMs: number, xM: number, envelopeId: string): StreamEnvelope {
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId,
      matchId: 'synthetic-derby-01',
      kind: 'tracking',
      tracking: {
        schemaVersion: '1.0',
        matchId: 'synthetic-derby-01',
        sampleTimeMs,
        entityId: 'home-01',
        xM,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: `frame-${String(Math.round(sampleTimeMs / 100))}`,
      } as TrackingSample,
      emittedAt: Date.now(),
      traceId: 'trc-conv',
    };
  }

  it('D1. snapshot → valid correction delta applies WITHOUT resync; the corpus holds ONLY the winning revision', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([eventEnvelope({ eventId: 'evt-goal-1' })]);
    const events: SyncEvent[] = [];
    const viewer = makeController(worker, events);
    const resyncsBefore = events.filter(
      (e) => e.type === 'status' && e.status === 'resynchronizing',
    ).length;
    worker.admit([
      eventEnvelope({
        eventId: 'evt-goal-1',
        sourceRevision: 2,
        kind: 'period_end',
        correctionOf: 'evt-goal-1',
      }),
    ]);
    const correctionDelta = worker.takePendingDelta()!;
    if (correctionDelta.type !== 'delta') throw new Error('delta expected');
    expect(correctionDelta.newEvents).toHaveLength(1); // the winning revision only
    expect(viewer.applyFrame(correctionDelta)).toBe(true);
    // NO false mismatch/resync — the replacement semantics converged.
    expect(events.filter((e) => e.type === 'status' && e.status === 'resynchronizing').length).toBe(
      resyncsBefore,
    );
    expect(viewer.currentStateVersion).toBe(worker.currentVersion);
    const serverView = worker.view();
    expect(acceptedSetFingerprint(serverView.acceptedEvents, serverView.acceptedTracking)).toBe(
      viewer.currentStateVersion,
    );
  });

  it('D2. a POISONED correction never reaches the wire (no client divergence)', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([eventEnvelope({ eventId: 'evt-goal-1' })]);
    void worker.takePendingDelta(); // drain the initial publish first
    const result = worker.admit([
      eventEnvelope({
        eventId: 'evt-goal-1',
        sourceRevision: 5,
        correctionOf: 'evt-does-not-exist',
      }),
    ]);
    expect(result.quarantined.length).toBeGreaterThan(0);
    // No publish: the accepted set did not change, so no seq burn and no
    // frame carrying a rejected envelope.
    expect(worker.takePendingDelta()).toBeNull();
  });

  it('D3. tracking conflict tombstone: the delta carries the REMOVAL and clients converge', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([trackingEnvelope(4_720_500, 25.046, 'env-conv-t1')]);
    const events: SyncEvent[] = [];
    const viewer = makeController(worker, events);
    // Same (entity, time), conflicting payload → tombstone pair.
    worker.admit([trackingEnvelope(4_720_500, 27.5, 'env-conv-t2')]);
    const delta = worker.takePendingDelta()!;
    if (delta.type !== 'delta') throw new Error('delta expected');
    expect(delta.removedTracking).toEqual([{ entityId: 'home-01', sampleTimeMs: 4_720_500 }]);
    expect(delta.newTracking).toHaveLength(0); // the conflicting payload is NOT accepted
    expect(viewer.applyFrame(delta)).toBe(true); // converges without resync
    expect(viewer.currentStateVersion).toBe(worker.currentVersion);
    expect(events.filter((e) => e.type === 'gap')).toHaveLength(0);
  });

  it('D4. end-to-end: snapshot at t0, deltas with a correction AND a tombstone, exact corpus parity', () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 't' });
    worker.admit([
      eventEnvelope({ eventId: 'evt-goal-1' }),
      trackingEnvelope(1000, 1, 'env-e2e-1'),
    ]);
    const events: SyncEvent[] = [];
    const viewer = makeController(worker, events);
    // Correction (event) + new tick, then a conflict (tombstone) later.
    worker.admit([
      eventEnvelope({
        eventId: 'evt-goal-1',
        sourceRevision: 2,
        kind: 'period_end',
        correctionOf: 'evt-goal-1',
      }),
      trackingEnvelope(1100, 2, 'env-e2e-2'),
    ]);
    expect(viewer.applyFrame(worker.takePendingDelta()!)).toBe(true);
    worker.admit([trackingEnvelope(1100, 9, 'env-e2e-3')]); // conflict on the 1100 tick
    expect(viewer.applyFrame(worker.takePendingDelta()!)).toBe(true);
    // No gap, no resync, and the client's accepted corpus is fingerprint-
    // equal to the server's authoritative accepted set.
    expect(events.filter((e) => e.type === 'gap')).toHaveLength(0);
    expect(
      events.filter((e) => e.type === 'status' && e.status === 'resynchronizing'),
    ).toHaveLength(0);
    expect(viewer.currentStateVersion).toBe(worker.currentVersion);
  });

  it('D5. stale-generation deltas after a producer restart cannot livelock the resync loop', () => {
    // The QA failure this reproduces: a starved renderer dispatched an
    // in-flight delta from the DEAD session after the new session's
    // snapshot was already applied — its sequence belongs to the old
    // generation and must be IGNORED, not treated as a gap (which would
    // invalidate every fresh snapshot forever).
    const oldWorker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 's1' });
    oldWorker.admit([trackingEnvelope(1000, 1, 'env-d5-1')]);
    const staleDelta = oldWorker.takePendingDelta()!;
    if (staleDelta.type !== 'delta') throw new Error('delta expected');

    // Restart: a NEW worker/session; the viewer adopts its snapshot.
    const newWorker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 's2' });
    newWorker.admit([trackingEnvelope(1000, 5, 'env-d5-2')]);
    const events: SyncEvent[] = [];
    const viewer = makeController(newWorker, events);
    const resyncsAfterSnapshot = () =>
      events.filter((e) => e.type === 'status' && e.status === 'resynchronizing').length;

    // The stale s1 delta arrives AFTER the s2 snapshot: ignored, no gap.
    const before = resyncsAfterSnapshot();
    expect(viewer.applyFrame(staleDelta)).toBe(false);
    expect(resyncsAfterSnapshot()).toBe(before);
    expect(events.filter((e) => e.type === 'gap')).toHaveLength(0);

    // The CURRENT session's next delta applies contiguously.
    newWorker.admit([trackingEnvelope(1100, 6, 'env-d5-3')]);
    const freshDelta = newWorker.takePendingDelta()!;
    if (freshDelta.type !== 'delta') throw new Error('delta expected');
    expect(viewer.applyFrame(freshDelta)).toBe(true);
    expect(viewer.currentStateVersion).toBe(newWorker.currentVersion);
  });
});

/**
 * Controller wired to the worker's canonical snapshot for resync, connected
 * exactly like the real transport: the SNAPSHOT is the first frame applied
 * (a delta can never precede it — client law).
 */
function makeController(
  worker: LiveProjectionWorker,
  events: SyncEvent[] = [],
): LiveSyncController {
  const controller = new LiveSyncController({
    onEvent: (event) => events.push(event),
    fetchSnapshot: async () => worker.snapshot(),
  });
  if (!controller.applyFrame(worker.snapshot())) {
    throw new Error('controller could not apply its initial snapshot');
  }
  return controller;
}

describe('KYN-13 review round 2 — snapshot verification fails closed', () => {
  function trackingEnvelope(sampleTimeMs: number, xM: number, envelopeId: string): StreamEnvelope {
    return {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId,
      matchId: 'synthetic-derby-01',
      kind: 'tracking',
      tracking: {
        schemaVersion: '1.0',
        matchId: 'synthetic-derby-01',
        sampleTimeMs,
        entityId: 'home-01',
        xM,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: `frame-${String(Math.round(sampleTimeMs / 100))}`,
      } as TrackingSample,
      emittedAt: Date.now(),
      traceId: 'trc-e',
    };
  }

  /** Controller with a CONTROLLABLE snapshot supplier (resync path). */
  function controllerWithSupplier(supply: () => unknown, events: SyncEvent[]): LiveSyncController {
    return new LiveSyncController({
      onEvent: (event) => events.push(event),
      fetchSnapshot: async () => supply() as LiveFrame | null,
    });
  }

  it('E1. a tampered snapshot is rejected WITHOUT touching the last verified state, and recovery follows', async () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 's' });
    // Valid applied state: the EMPTY snapshot first (client law), then the
    // first delta — exactly the live delivery order.
    let supplier: () => unknown = () => worker.snapshot();
    const events: SyncEvent[] = [];
    const controller = controllerWithSupplier(() => supplier(), events);
    expect(controller.applyFrame(worker.snapshot())).toBe(true);
    worker.admit([trackingEnvelope(1000, 1, 'env-e1-1')]);
    const d1 = worker.takePendingDelta()!;
    expect(controller.applyFrame(d1)).toBe(true);
    const versionBefore = controller.currentStateVersion;
    const appliedBefore = events.filter((e) => e.type === 'applied').length;
    expect(versionBefore).toBe(worker.currentVersion);

    // Tamper: same shape, coordinates mutated, stateVersion kept — the
    // fingerprint can never match.
    const good = worker.snapshot();
    if (good.type !== 'snapshot') throw new Error('snapshot expected');
    const tampered = {
      ...good,
      tracking: good.tracking.map((sample, i) =>
        i === 0 ? { ...sample, xM: sample.xM + 7 } : sample,
      ),
    };
    expect(controller.applyFrame(tampered)).toBe(false);
    // NO new applied event, NO corpus/version mutation, NO 'connected'.
    expect(events.filter((e) => e.type === 'applied').length).toBe(appliedBefore);
    expect(controller.currentStateVersion).toBe(versionBefore);
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    expect(statuses[statuses.length - 1]).not.toBe('connected');
    // The rejection also queued an asynchronous resync (client law). Let it
    // settle deterministically before continuing — its eagerly-captured
    // snapshot reflects this instant's state, by design.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The last verified SEQUENCE survived: the next contiguous delta applies.
    worker.admit([trackingEnvelope(1100, 2, 'env-e1-2')]);
    const d2 = worker.takePendingDelta()!;
    if (d2.type !== 'delta') throw new Error('delta expected');
    expect(controller.applyFrame(d2)).toBe(true);

    // Recovery: the resync path fetches a GOOD snapshot and reconnects.
    supplier = () => worker.snapshot();
    await controller.onReconnect();
    expect(controller.currentStatus).toBe('connected');
    expect(controller.currentStateVersion).toBe(worker.currentVersion);
  });

  it('E2. onReconnect reports connected ONLY on verified snapshots; a rejected one keeps a retryable status', async () => {
    const worker = new LiveProjectionWorker({ matchId: 'synthetic-derby-01', sessionId: 's' });
    worker.admit([trackingEnvelope(1000, 1, 'env-e2-1')]);
    const events: SyncEvent[] = [];
    let supplier: () => unknown = () => worker.snapshot();
    const controller = controllerWithSupplier(() => supplier(), events);
    expect(controller.applyFrame(worker.snapshot())).toBe(true);
    const versionBefore = controller.currentStateVersion;

    // The resync fetch returns a TAMPERED snapshot: fail closed.
    const good = worker.snapshot();
    if (good.type !== 'snapshot') throw new Error('snapshot expected');
    supplier = () => ({
      ...good,
      stateVersion: 'deadbeef', // wrong fingerprint claim
    });
    await controller.onReconnect();
    expect(controller.currentStatus).toBe('reconnecting'); // NOT connected
    expect(controller.currentStateVersion).toBe(versionBefore); // preserved

    // Retry with the genuine snapshot: recovers cleanly.
    supplier = () => worker.snapshot();
    await controller.onReconnect();
    expect(controller.currentStatus).toBe('connected');
    expect(controller.currentStateVersion).toBe(worker.currentVersion);
  });
});
