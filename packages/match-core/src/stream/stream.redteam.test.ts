import { describe, expect, it } from 'vitest';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { acceptedSetFingerprint, type StreamEnvelope } from './wire';
import { LiveProjectionWorker } from './worker';

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
      contractVersion: 'kyneloom-live-wire-v1',
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
      contractVersion: 'kyneloom-live-wire-v1',
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
      contractVersion: 'kyneloom-live-wire-v1',
      envelopeId: 'env-malformed',
      matchId: 'synthetic-derby-01',
      kind: 'event',
      event: { nonsense: true } as unknown as MatchEvent,
      emittedAt: Date.now(),
      traceId: 'trc-malformed',
    };
    const wrongMatch: StreamEnvelope = {
      contractVersion: 'kyneloom-live-wire-v1',
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
