import { describe, expect, it } from 'vitest';
import {
  parseMomentProposal,
  PROPOSAL_TOOL_ALLOWLIST,
  type MomentProposal,
} from './moment-proposal';

/**
 * KYN-16 — MomentProposal schema contract tests (v0.2.0). The proposal is
 * the UNTRUSTED side of the compiler boundary; these pin the fail-closed
 * law at schema level: unknown keys, non-finite numbers, misplaced
 * assertions — and, since the review round, THE TEXT LAW: untrusted prose
 * can never ride along on a verified claim, and editorial prose is
 * number-free.
 */

function minimalProposal(): Record<string, unknown> {
  return {
    schemaVersion: '0.2.0',
    proposalId: 'demo-proposal-01',
    origin: 'local-deterministic',
    tenantId: 'demo-org',
    matchId: 'synthetic-derby-01',
    candidateRef: 'cand-demo',
    basedOn: { reducerRevision: 11, sourceHash: 'sha256:' + 'a'.repeat(64) },
    timeRangeMs: [4721700, 4729800],
    tools: ['get_metric'],
    cameraTracks: [
      {
        id: 'cam-01',
        mode: 'directed',
        startMs: 0,
        endMs: 8100,
        keyframes: [
          { tMs: 0, position: [0, 20, 12], target: [0, 0, 0], fovDeg: 40 },
          { tMs: 8100, position: [20, 10, 8], target: [30, 0, 1], fovDeg: 38 },
        ],
      },
    ],
    overlays: [
      {
        id: 'ov-01',
        kind: 'distance',
        startMs: 1000,
        endMs: 6000,
        evidenceIds: ['ev-01'],
      },
    ],
    claims: [
      {
        id: 'claim-01',
        status: 'calculated',
        evidenceIds: ['ev-01'],
        language: 'en',
        metricAssertion: {
          kind: 'separation-delta',
          args: { defenderId: 'away-03', strikerId: 'home-09', fromMs: 4721700, toMs: 4729800 },
          valueField: 'deltaM',
          assertedValue: 16.746,
        },
      },
      {
        id: 'claim-02',
        status: 'hypothesis',
        evidenceIds: ['ev-01'],
        language: 'en',
        text: 'The decoy run likely contributed to the space.',
        inferenceDisclosure: 'Tactical interpretation; not a causal measurement.',
      },
    ],
    evidence: [
      {
        id: 'ev-01',
        kind: 'derived_metric',
        ref: 'metric-separation-demo',
        metricQuery: {
          kind: 'separation-delta',
          args: { defenderId: 'away-03', strikerId: 'home-09', fromMs: 4721700, toMs: 4729800 },
        },
        inputRefs: ['frame-47217', 'frame-47298'],
      },
    ],
    lenses: ['fan'],
    rightsPolicyRef: 'synthetic-0bsd-demo-v1',
    assetUrls: ['https://assets.kyneloom.local/tenants/demo-org/badges/x.svg'],
    recapHeadline: 'A run and a finish',
  };
}

describe('MomentProposal schema', () => {
  it('parses the minimal well-formed document', () => {
    const result = parseMomentProposal(minimalProposal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.origin).toBe('local-deterministic');
      expect(result.data.tools).toEqual(['get_metric']);
    }
  });

  it('rejects an unknown top-level key — no script/command field can be smuggled in', () => {
    const document = minimalProposal();
    document['script'] = 'while(true) {}';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'unrecognized_key')).toBe(true);
    }
  });

  it('rejects a newer schema version with an unsupported_version error', () => {
    const document = minimalProposal();
    document['schemaVersion'] = '0.3.0';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('unsupported_version');
      expect(result.errors[0]?.fieldPath).toBe('schemaVersion');
    }
  });

  it('rejects a NaN camera coordinate with the exact field path', () => {
    const document = minimalProposal();
    const tracks = document['cameraTracks'] as { keyframes: { position: unknown[] }[] }[];
    tracks[0]!.keyframes[0]!.position = [Number.NaN, 20, 12];
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const path = result.errors.find((error) => error.fieldPath.includes('position'));
      expect(path).toBeDefined();
    }
  });

  it('rejects a metricAssertion on a hypothesis claim', () => {
    const document = minimalProposal();
    const claims = document['claims'] as { id: string }[];
    const hypothesis = claims.find((claim) => claim.id === 'claim-02') as {
      metricAssertion?: unknown;
    };
    hypothesis['metricAssertion'] = {
      kind: 'separation-delta',
      args: { defenderId: 'away-03', strikerId: 'home-09', fromMs: 4721700, toMs: 4729800 },
      valueField: 'deltaM',
      assertedValue: 16.746,
    };
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[1].metricAssertion')).toBe(
        true,
      );
    }
  });

  it('rejects derived_metric evidence without a metric query', () => {
    const document = minimalProposal();
    const evidence = document['evidence'] as { metricQuery?: unknown }[];
    delete evidence[0]!.metricQuery;
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'evidence[0].metricQuery')).toBe(
        true,
      );
    }
  });

  it('rejects overlays citing evidence the proposal does not declare', () => {
    const document = minimalProposal();
    const overlays = document['overlays'] as { evidenceIds: string[] }[];
    overlays[0]!.evidenceIds = ['ev-missing'];
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'overlays[0].evidenceIds[0]')).toBe(
        true,
      );
    }
  });

  it('rejects an http asset URL (https-only gate applies to proposals too)', () => {
    const document = minimalProposal();
    document['assetUrls'] = ['http://assets.kyneloom.local/tenants/demo-org/x.svg'];
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'assetUrls[0]')).toBe(true);
    }
  });

  it('rejects an end-before-start window', () => {
    const document = minimalProposal();
    document['timeRangeMs'] = [4729800, 4721700];
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'timeRangeMs')).toBe(true);
    }
  });

  it('documents the read-only tool allowlist unchanged (docs/07 law)', () => {
    expect([...PROPOSAL_TOOL_ALLOWLIST]).toEqual([
      'get_metric',
      'get_event_window',
      'validate_camera_plan',
      'validate_claims',
    ]);
  });

  it('round-trips a parsed proposal through JSON without losing validity', () => {
    const first = parseMomentProposal(minimalProposal());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseMomentProposal(JSON.parse(JSON.stringify(first.data)) as MomentProposal);
    expect(second.ok).toBe(true);
  });
});

describe('MomentProposal text law (review blocker A)', () => {
  it('rejects a calculated claim without a metricAssertion — prose alone is not proof', () => {
    const document = minimalProposal();
    const claims = document['claims'] as { id: string; metricAssertion?: unknown }[];
    delete claims[0]!.metricAssertion;
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.errors.find(
        (candidate) => candidate.fieldPath === 'claims[0].metricAssertion',
      );
      expect(error).toBeDefined();
      expect(error!.message).toContain('metricAssertion');
    }
  });

  it('rejects proposed text on a calculated claim — verified text is compiler-generated', () => {
    const document = minimalProposal();
    const claims = document['claims'] as { id: string }[];
    (claims[0] as { text?: string }).text = 'The defender was exactly 14 metres away.';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[0].text')).toBe(true);
    }
  });

  it('rejects proposed text on an observed claim', () => {
    const document = minimalProposal();
    const claims = document['claims'] as Record<string, unknown>[];
    claims[0] = {
      id: 'claim-01',
      status: 'observed',
      evidenceIds: ['ev-01'],
      language: 'en',
      text: 'A stunning pass.',
    };
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[0].text')).toBe(true);
    }
  });

  it('rejects a hypothesis without editorial text', () => {
    const document = minimalProposal();
    const claims = document['claims'] as { id: string }[];
    const hypothesis = claims.find((claim) => claim.id === 'claim-02') as { text?: string };
    delete hypothesis.text;
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[1].text')).toBe(true);
    }
  });

  it('rejects a number token in editorial hypothesis text', () => {
    const document = minimalProposal();
    const claims = document['claims'] as { id: string }[];
    const hypothesis = claims.find((claim) => claim.id === 'claim-02') as { text?: string };
    hypothesis.text = 'The gap was fourteen metres at the end, likely from the run.';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.errors.find((candidate) => candidate.fieldPath === 'claims[1].text');
      expect(error).toBeDefined();
      expect(error!.message).toContain('fourteen');
    }
  });

  it('rejects a digit in the recap headline', () => {
    const document = minimalProposal();
    document['recapHeadline'] = 'The 14-metre gap that won it';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.errors.find((candidate) => candidate.fieldPath === 'recapHeadline');
      expect(error).toBeDefined();
      expect(error!.message).toContain('14');
    }
  });
});
