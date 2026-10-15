import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, parseMatchEvent, type MatchEvent } from './match-event';
import { EVENT_SCHEMA_VERSION } from './versioning';
import { isBallEntity, entityTeam } from './ids';
import { pitchToThree, threeToPitch } from './spatial';
import { assetUrl } from './asset-url';
import { toContractValidationErrors } from './errors';
import { z } from 'zod';

const validEvent = {
  schemaVersion: '1.0',
  eventId: 'evt-0042',
  providerId: 'kyneloom-simulator',
  tenantId: 'demo-org',
  matchId: 'synthetic-derby-01',
  fixtureSeed: 24017,
  sourceRevision: 1,
  kind: 'pass_completed',
  occurredAtMs: 4722000,
  ingestedAt: '2026-10-12T14:30:05Z',
  sequence: 414,
  actorId: 'home-08',
  teamId: 'home',
  position: { xM: 21.4, yM: -13.8 },
  attributes: { target_player_id: 'home-09' },
  provenance: {
    origin: 'synthetic_ground_truth',
    generatorVersion: 'fixture-engine-v1',
    confidence: 1,
  },
  correctionOf: null,
};

describe('parseMatchEvent — valid documents', () => {
  it('accepts the canonical docs/05 example', () => {
    const result = parseMatchEvent(validEvent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe('pass_completed');
    expect(result.data.position?.xM).toBeCloseTo(21.4);
    expect(result.data.provenance.origin).toBe('synthetic_ground_truth');
  });

  it('accepts an event without position or attributes (substitution)', () => {
    const result = parseMatchEvent({
      ...validEvent,
      eventId: 'evt-sub-1',
      kind: 'substitution',
      position: undefined,
      attributes: undefined,
      actorId: null,
      teamId: null,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts every allowlisted event kind', () => {
    for (const [index, kind] of EVENT_KINDS.entries()) {
      const result = parseMatchEvent({ ...validEvent, eventId: `evt-kind-${index}`, kind });
      expect(result.ok, `kind ${kind} should parse`).toBe(true);
    }
  });

  it('accepts a correction envelope referencing a prior event id', () => {
    const result = parseMatchEvent({
      ...validEvent,
      eventId: 'evt-0042-r2',
      sourceRevision: 2,
      correctionOf: 'evt-0042',
    });
    expect(result.ok).toBe(true);
  });
});

describe('parseMatchEvent — rejections', () => {
  it('rejects NaN, Infinity and negative timestamps', () => {
    for (const occurredAtMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const result = parseMatchEvent({ ...validEvent, occurredAtMs });
      expect(result.ok, `occurredAtMs ${String(occurredAtMs)}`).toBe(false);
      if (result.ok) continue;
      expect(result.errors.some((e) => e.fieldPath === 'occurredAtMs')).toBe(true);
    }
  });

  it('rejects NaN and Infinity inside positions', () => {
    const result = parseMatchEvent({ ...validEvent, position: { xM: Number.NaN, yM: 0 } });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed ids', () => {
    for (const eventId of ['', 'Bad_ID', 'spaces in id', 'id/slash']) {
      expect(parseMatchEvent({ ...validEvent, eventId }).ok, eventId).toBe(false);
    }
    expect(parseMatchEvent({ ...validEvent, matchId: 'Match#1' }).ok).toBe(false);
  });

  it('rejects unknown event kinds with the allowlist message', () => {
    const result = parseMatchEvent({ ...validEvent, kind: 'teleport' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const kindError = result.errors.find((e) => e.fieldPath === 'kind');
    expect(kindError).toBeDefined();
    expect(kindError?.code).toBe('invalid_value');
  });

  it('rejects unexpected properties (strict unknown-field policy)', () => {
    const result = parseMatchEvent({ ...validEvent, execute: 'console.log("pwned")' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'unrecognized_key')).toBe(true);
  });

  it('rejects illegal provenance origins (interpolated/hypothesis are not event facts)', () => {
    for (const origin of ['interpolated', 'extrapolated', 'hypothesis']) {
      const result = parseMatchEvent({ ...validEvent, provenance: { origin, confidence: 1 } });
      expect(result.ok, origin).toBe(false);
    }
  });

  it('rejects confidence outside [0,1]', () => {
    for (const confidence of [-0.1, 1.5, Number.NaN]) {
      expect(
        parseMatchEvent({ ...validEvent, provenance: { origin: 'source_observed', confidence } })
          .ok,
      ).toBe(false);
    }
  });

  it('rejects structured attributes (primitives only)', () => {
    const result = parseMatchEvent({ ...validEvent, attributes: { nested: { deep: true } } });
    expect(result.ok).toBe(false);
  });

  it('rejects non-UTC and malformed ingestion timestamps', () => {
    for (const ingestedAt of ['2026-10-12 14:30:05', 'not-a-date', '2026-10-12T14:30:05+02:00']) {
      expect(parseMatchEvent({ ...validEvent, ingestedAt }).ok, ingestedAt).toBe(false);
    }
  });

  it('rejects unsupported schema versions with expected/found', () => {
    const result = parseMatchEvent({ ...validEvent, schemaVersion: '2.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const versionError = result.errors.find((e) => e.code === 'unsupported_version');
    expect(versionError?.fieldPath).toBe('schemaVersion');
    expect(versionError?.message).toContain(EVENT_SCHEMA_VERSION);
    expect(versionError?.message).toContain('2.0');
  });

  it('rejects zero and negative source revisions', () => {
    expect(parseMatchEvent({ ...validEvent, sourceRevision: 0 }).ok).toBe(false);
    expect(parseMatchEvent({ ...validEvent, sourceRevision: -3 }).ok).toBe(false);
  });

  it('rejects team ids outside home/away when present', () => {
    expect(parseMatchEvent({ ...validEvent, teamId: 'neutral' }).ok).toBe(false);
  });
});

describe('entity identity helpers', () => {
  it('distinguishes ball from players', () => {
    expect(isBallEntity('ball')).toBe(true);
    expect(isBallEntity('home-08')).toBe(false);
    expect(entityTeam('away-04')).toBe('away');
    expect(entityTeam('home-gk')).toBe('home');
    expect(entityTeam('ball')).toBeNull();
  });
});

describe('pitchToThree / threeToPitch (docs/08 single transform)', () => {
  it('maps the right goal-line corner flag by hand: (52.5, 34, 0) → (52.5, 0, -34)', () => {
    expect([...pitchToThree({ xM: 52.5, yM: 34, zM: 0 })]).toEqual([52.5, 0, -34]);
  });

  it('maps the left goal mouth center: (-52.5, 0, 2.44/2) keeps height on y', () => {
    expect([...pitchToThree({ xM: -52.5, yM: 0, zM: 1.22 })]).toEqual([-52.5, 1.22, 0]);
  });

  it('round-trips arbitrary points through both directions', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [12, -31.5, 7.25],
      [-40, 10, 3],
    ] as const) {
      const there = pitchToThree({ xM: x, yM: y, zM: z });
      const back = threeToPitch(there);
      expect(back).toEqual([x, y, z]);
    }
  });

  it('accepts tuple form (manifest keyframes use tuples)', () => {
    expect([...pitchToThree([0, 46, 48])]).toEqual([0, 48, -46]);
  });
});

describe('assetUrl gate (ADR-0002 proof obligation)', () => {
  it('accepts https URLs only', () => {
    expect(assetUrl.safeParse('https://assets.kyneloom.example/kit.v1.glb').success).toBe(true);
  });

  it('rejects dangerous schemes and malformed URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'http://insecure.example/a.glb',
      'ftp://assets.example/a.glb',
      'https://user:pass@assets.example/a.glb',
      'https://assets.example/a.glb#fragment',
      'not-a-url',
    ]) {
      expect(assetUrl.safeParse(url).success, url).toBe(false);
    }
  });
});

describe('toContractValidationErrors', () => {
  it('converts zod issues into precise dot/bracket field paths', () => {
    const schema = z.strictObject({ list: z.array(z.strictObject({ n: z.number() })) });
    const bad = schema.safeParse({ list: [{ n: 'x' }], extra: 1 });
    expect(bad.success).toBe(false);
    if (bad.success) return;
    const errors = toContractValidationErrors(bad.error);
    expect(errors.some((e) => e.fieldPath === 'list[0].n' && e.code === 'invalid_type')).toBe(true);
    expect(errors.some((e) => e.code === 'unrecognized_key')).toBe(true);
  });
});

describe('typed consumption compile check', () => {
  it('exposes a MatchEvent type usable by downstream packages', () => {
    const result = parseMatchEvent(validEvent);
    if (!result.ok) throw new Error('fixture must parse');
    const event: MatchEvent = result.data;
    const origin: string = event.provenance.origin;
    expect(origin).toBe('synthetic_ground_truth');
  });
});

describe('event provenance source-rights policy (review optional finding)', () => {
  it('rejects source_observed events without a license reference', () => {
    const result = parseMatchEvent({
      ...validEvent,
      provenance: { origin: 'source_observed', confidence: 0.95 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((e) => e.fieldPath === 'provenance.licenseRef');
    expect(error).toBeDefined();
    expect(error?.message).toContain('licenseRef');
  });

  it('accepts source_observed events with a license reference', () => {
    const result = parseMatchEvent({
      ...validEvent,
      provenance: {
        origin: 'source_observed',
        licenseRef: 'skillcorner-open-data-2025',
        confidence: 0.95,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects synthetic_ground_truth events without a generator version', () => {
    const result = parseMatchEvent({
      ...validEvent,
      provenance: { origin: 'synthetic_ground_truth', confidence: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'provenance.generatorVersion')).toBe(true);
  });

  it('accepts both fields present regardless of origin', () => {
    const result = parseMatchEvent({
      ...validEvent,
      provenance: {
        origin: 'synthetic_ground_truth',
        generatorVersion: 'fixture-engine-v1',
        licenseRef: 'synthetic-internal',
        confidence: 1,
      },
    });
    expect(result.ok).toBe(true);
  });
});
