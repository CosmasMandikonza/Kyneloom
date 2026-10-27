import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJsonStringify, type MatchEvent } from '@kyneloom/contracts';
import {
  LiveProjectionWorker,
  STREAM_CONTRACT_VERSION,
  type StreamEnvelope,
} from '@kyneloom/match-core';
import { acquireOwnedArchive } from './owned-archive';
import { createBlobArchive } from './blob-archive';
import { OWNED_CONFIG as config, ownedStorage } from './test-support/owned-storage';

function batch(id: string, time = 1000): StreamEnvelope[] {
  return [
    {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: id,
      matchId: config.matchId,
      kind: 'tracking',
      emittedAt: time,
      traceId: id,
      tracking: {
        schemaVersion: '1.0',
        matchId: config.matchId,
        sampleTimeMs: time,
        entityId: 'home-01',
        xM: time / 1000,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: id,
      },
    },
  ];
}
function name(input: readonly StreamEnvelope[]): string {
  return `${config.matchId}/batches-v2/${createHash('sha256').update(canonicalJsonStringify(input)).digest('hex')}.json`;
}
function event(id: string, overrides: Partial<MatchEvent> = {}): StreamEnvelope {
  return {
    contractVersion: STREAM_CONTRACT_VERSION,
    envelopeId: id,
    matchId: config.matchId,
    kind: 'event',
    emittedAt: 1000,
    traceId: id,
    event: {
      schemaVersion: '1.0',
      eventId: 'goal',
      providerId: 'kyneloom-simulator',
      tenantId: 'demo-org',
      matchId: config.matchId,
      fixtureSeed: 24017,
      sourceRevision: 1,
      kind: 'goal',
      occurredAtMs: 1000,
      ingestedAt: '2026-10-12T14:30:05Z',
      sequence: 1,
      actorId: 'home-08',
      teamId: 'home',
      position: { xM: 1, yM: 2 },
      attributes: {},
      correctionOf: null,
      provenance: {
        origin: 'synthetic_ground_truth',
        generatorVersion: 'fixture-engine-v1',
        confidence: 1,
      },
      ...overrides,
    },
  };
}
const opened: Awaited<ReturnType<typeof acquireOwnedArchive>>[] = [];
async function open(store: ReturnType<typeof ownedStorage>, signal?: AbortSignal) {
  const archive = await acquireOwnedArchive(config, {
    createContainer: store.createContainer,
    now: Date.now,
    ...(signal ? { signal } : {}),
  });
  opened.push(archive);
  return archive;
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const archive of opened.splice(0)) await archive.ownership.close();
  vi.useRealTimers();
});

describe('lease-protected canonical archive through the real Blob SDK', () => {
  it('A acquires, B waits without processing; clean release allows B to take over', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const controller = new AbortController();
    let acquired = false;
    const waiting = open(store, controller.signal).then((value) => {
      acquired = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acquired).toBe(false);
    expect(store.record().generation).toBe('1');
    await a.ownership.close();
    await vi.advanceTimersByTimeAsync(1000);
    const b = await waiting;
    expect(b.ownership.generation).toBe('2');
    expect(
      store.requests.some((r) => r.name.endsWith('/commit-v1') && r.lease && r.condition),
    ).toBe(true);
  });

  it('renews and remains owned past the original lease; renewal failure revokes ownership', async () => {
    const store = ownedStorage();
    const a = await open(store);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(() => a.ownership.assertOwned()).not.toThrow();
    store.failRenew();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.ownership.signal.aborted).toBe(true);
    await expect(a.appendEnvelopes(batch('retired'))).rejects.toThrow();
    expect(store.record().batches).toHaveLength(0);
  });

  it('a crashed owner expires; a replacement recovers the committed prefix', async () => {
    const store = ownedStorage();
    const a = await open(store);
    await a.appendEnvelopes(batch('one'));
    vi.setSystemTime(Date.now() + 121_000); // no renewal callback: paused/crashed process
    const b = await open(store);
    expect(b.ownership.generation).toBe('2');
    expect(await b.readBatches()).toEqual([batch('one')]);
    expect(() => a.ownership.assertOwned()).toThrow();
  });

  it('a delayed old upload is an orphan, never a canonical receipt after takeover', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const old = batch('old');
    const delayed = store.delayNext(name(old));
    const writing = a.appendEnvelopes(old).catch((error) => error as Error);
    await delayed.started.promise;
    vi.setSystemTime(Date.now() + 121_000);
    const b = await open(store);
    await b.appendEnvelopes(batch('new'));
    delayed.finish.resolve();
    expect(await writing).toBeInstanceOf(Error);
    expect(store.objects.has(name(old))).toBe(true);
    expect(await b.readBatches()).toEqual([batch('new')]);
    expect(store.record().batches).toHaveLength(1);
  });

  it('Storage rejects an already-issued stale commit after B commits its generation', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const delayed = store.delayNext(`${config.matchId}/commit-v1`);
    const writing = a.appendEnvelopes(batch('old')).catch((error) => error as Error);
    await delayed.started.promise; // immutable upload completed, commit request now in flight
    vi.setSystemTime(Date.now() + 121_000);
    const b = await open(store);
    await b.appendEnvelopes(batch('new'));
    const committed = store.record();
    delayed.finish.resolve();
    expect(await writing).toBeInstanceOf(Error);
    expect(store.record()).toEqual(committed);
    expect(await b.readBatches()).toEqual([batch('new')]);
    await a.ownership.close(); // cannot release B's lease
    expect(() => b.ownership.assertOwned()).not.toThrow();
  });

  it('commit failure after upload leaves no replayable batch; retries reuse immutable bytes', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const delayed = store.delayNext(`${config.matchId}/commit-v1`);
    const writing = a.appendEnvelopes(batch('orphan')).catch((error) => error as Error);
    await delayed.started.promise;
    vi.setSystemTime(Date.now() + 121_000);
    const b = await open(store);
    expect(await b.readBatches()).toEqual([]);
    delayed.finish.resolve();
    expect(await writing).toBeInstanceOf(Error);
    await b.appendEnvelopes(batch('orphan'));
    await b.appendEnvelopes(batch('orphan'));
    expect(await b.readBatches()).toEqual([batch('orphan')]);
    expect(store.record().batches).toHaveLength(1);
  });

  it('an ambiguous commit acknowledgment retires A; B replays the valid commit', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const delayed = store.delayNext(`${config.matchId}/commit-v1`, 'after');
    const writing = a.appendEnvelopes(batch('committed')).catch((error) => error as Error);
    await delayed.started.promise;
    vi.setSystemTime(Date.now() + 121_000);
    const b = await open(store);
    expect(await b.readBatches()).toEqual([batch('committed')]);
    delayed.finish.resolve();
    expect(await writing).toBeInstanceOf(Error);
    await b.appendEnvelopes(batch('committed')); // crash before checkpoint → exact redelivery
    expect(store.record().batches).toHaveLength(1);
  });

  it('serializes concurrent admissions and reconstructs the same existing reducer state after restart', async () => {
    const store = ownedStorage();
    const a = await open(store);
    const input = [
      batch('one'),
      batch('two', 1100),
      batch('revised', 1100),
      [{ ...batch('invalid')[0]!, tracking: undefined }],
    ];
    // A tracking revision at the same source identity, plus a quarantined record.
    input[2]![0]!.tracking!.xM = 9;
    // Preserve admission boundaries, including a correction arriving before
    // its target; recovery must reproduce the original reducer decisions.
    input.unshift(
      [
        event('early-correction', {
          sourceRevision: 2,
          correctionOf: 'goal',
          kind: 'pass_completed',
        }),
      ],
      [event('base-goal')],
      [
        event('valid-correction', {
          sourceRevision: 2,
          correctionOf: 'goal',
          kind: 'pass_completed',
        }),
      ],
      [
        event('conflict', {
          sourceRevision: 2,
          correctionOf: 'goal',
          kind: 'pass_completed',
          position: { xM: 9, yM: 2 },
        }),
      ],
    );
    await Promise.all(input.map((value) => a.appendEnvelopes(value)));
    const reference = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'reference' });
    const original = input.map((value) => reference.admit(value));
    expect(original.some((outcome) => outcome.quarantined.length > 0)).toBe(true);
    await a.ownership.close();
    const b = await open(store);
    const recovered = new LiveProjectionWorker({ matchId: config.matchId, sessionId: 'reference' });
    const replayed = await b.readBatches();
    expect(replayed).toHaveLength(input.length);
    const outcomes = replayed.map((value) => recovered.admit(value));
    expect(outcomes).toEqual(original);
    expect(recovered.currentVersion).toBe(reference.currentVersion);
    expect(recovered.snapshot()).toEqual(reference.snapshot());
    expect(recovered.view().acceptedEvents).toEqual(reference.view().acceptedEvents);
    expect(recovered.view().acceptedTracking).toEqual(reference.view().acceptedTracking);
    expect(recovered.view().projection.eventHistory()).toEqual(
      reference.view().projection.eventHistory(),
    );
    expect(recovered.view().projection.matchStateAt(1100)).toEqual(
      reference.view().projection.matchStateAt(1100),
    );
    for (let revision = 0; revision <= reference.view().projection.revisionCount; revision++) {
      expect(recovered.view().projection.matchStateAt(1100, revision)).toEqual(
        reference.view().projection.matchStateAt(1100, revision),
      );
    }
    expect(recovered.view().projection.timeline.sampleAt(1050)).toEqual(
      reference.view().projection.timeline.sampleAt(1050),
    );
    expect(recovered.currentSeq).toBe(reference.currentSeq);
    expect(store.record().batches).toHaveLength(input.length);
  });

  it('fails closed on legacy history and on tampered committed data', async () => {
    const legacy = ownedStorage();
    legacy.objects.set(`${config.matchId}/old/batch-0.json`, {
      bytes: Buffer.from('[]'),
      etag: '"legacy"',
    });
    await expect(open(legacy)).rejects.toThrow('offline migration');
    const store = ownedStorage();
    const a = await open(store);
    const input = batch('one');
    await a.appendEnvelopes(input);
    store.objects.get(name(input))!.bytes = Buffer.from('[]');
    await expect(a.readBatches()).rejects.toThrow('hash mismatch');
  });

  it('never lets a legacy reader list orphans, or silently reinitializes a missing commit record', async () => {
    const store = ownedStorage();
    const a = await open(store);
    await a.appendEnvelopes(batch('one'));
    await expect(createBlobArchive(config, store.createContainer)).rejects.toThrow('owned reader');
    await a.ownership.close();
    store.objects.delete(`${config.matchId}/commit-v1`);
    await expect(open(store)).rejects.toThrow('offline migration/restore');
    expect(store.objects.has(`${config.matchId}/commit-v1`)).toBe(false);
  });
});
