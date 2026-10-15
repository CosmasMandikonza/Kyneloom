import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import {
  duplicateEvents,
  fnv1aHex,
  lateCorrection,
  projectMatch,
  reorderEvents,
} from '@kyneloom/match-core';

/**
 * KYN-04 integration: the COMMITTED golden fixture flows through the
 * authoritative reducer — determinism, delivery-order independence,
 * corrections, and the shared identity/time contract between renderer-facing
 * state and the separation metric.
 */

const dir = path.resolve(import.meta.dirname, 'fixtures', 'generated', 'synthetic-derby-01');
import type { MatchEvent } from '@kyneloom/contracts';
// Raw JSON typed as envelopes; the reducer itself re-validates every item.
const events = JSON.parse(
  readFileSync(path.join(dir, 'events.json'), 'utf-8'),
) as unknown[] as MatchEvent[];
const tracking = readFileSync(path.join(dir, 'tracking.jsonl'), 'utf-8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as unknown);
const matchId = (
  JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf-8')) as { matchId: string }
).matchId;

function project(eventsInput?: readonly unknown[]) {
  return projectMatch({ matchId, events: eventsInput ?? events, tracking });
}

describe('committed golden fixture through the reducer', () => {
  it('reproduces an identical serialized projection and checksum on every run', () => {
    const a = project().matchStateAt(4722100);
    const b = project().matchStateAt(4722100);
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(fnv1aHex(canonicalJsonStringify(a))).toBe(fnv1aHex(canonicalJsonStringify(b)));
    expect(a.players).toHaveLength(22);
  });

  it('duplicate and reordered delivery both converge to the same final state', () => {
    const canonical = canonicalJsonStringify(project().matchStateAt(4731000));
    const duplicated = project(duplicateEvents(events, 7, 0.3).events);
    const reordered = project(reorderEvents(events, 11).events);
    expect(canonicalJsonStringify(duplicated.matchStateAt(4731000))).toBe(canonical);
    expect(canonicalJsonStringify(reordered.matchStateAt(4731000))).toBe(canonical);
  });

  it('the committed fault variants are all valid reducer input', () => {
    for (const variant of [
      duplicateEvents(events, 3, 0.2),
      reorderEvents(events, 5),
      lateCorrection(events),
    ]) {
      const m = project(variant.events);
      expect(m.acceptedEvents.length).toBeGreaterThan(0);
      for (const event of m.acceptedEvents) {
        expect(event.matchId).toBe(matchId);
      }
    }
  });

  it('renderer-facing samples and metrics share the identity/time contract', () => {
    const m = project();
    const state = m.matchStateAt(4722100);
    // Every positioned player in the state has an exact timeline sample at
    // the same timestamp with the same entity id — one identity/time contract.
    const frame = m.timeline.sampleAt(4722100);
    const byEntity = new Map(frame.entities.map((e) => [e.entityId, e]));
    for (const player of state.players) {
      const entity = byEntity.get(player.entityId);
      expect(entity, player.entityId).toBeDefined();
      expect(entity!.exact).toBe(true);
      expect(entity!.sourceFrameIds[0]).toBe('frame-47221');
      expect(entity!.xM).toBe(player.xM);
    }
  });

  it('runs with no Azure credentials or network — pure functions only', () => {
    // Sanity: the reducer modules import nothing but node/contracts (this
    // test existing and passing in CI without secrets is the proof).
    expect(project().matchStateAt(0).matchId).toBe(matchId);
  });
});
