import { describe, expect, it } from 'vitest';
import {
  parseMomentProposal,
  PROPOSAL_TOOL_ALLOWLIST,
  type MomentProposal,
} from './moment-proposal';

/**
 * KYN-16 — MomentProposal schema contract tests. The proposal is the
 * UNTRUSTED side of the compiler boundary; these pin the fail-closed law at
 * schema level (unknown keys, non-finite numbers, misplaced assertions),
 * before any semantic verification runs.
 */

function minimalProposal(): unknown {
  return {
    schemaVersion: '0.1.0',
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
        text: 'The gap grew.',
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
    recapHeadline: 'One run, one goal',
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
    const document = minimalProposal() as Record<string, unknown>;
    document['script'] = 'while(true) {}';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'unrecognized_key')).toBe(true);
    }
  });

  it('rejects a newer schema version with an unsupported_version error', () => {
    const document = minimalProposal() as Record<string, unknown>;
    document['schemaVersion'] = '0.2.0';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('unsupported_version');
      expect(result.errors[0]?.fieldPath).toBe('schemaVersion');
    }
  });

  it('rejects a NaN camera coordinate with the exact field path', () => {
    const document = minimalProposal() as Record<string, unknown>;
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
    const document = minimalProposal() as Record<string, unknown>;
    const claims = document['claims'] as { status: string; inferenceDisclosure?: string }[];
    claims[0]!.status = 'hypothesis';
    claims[0]!.inferenceDisclosure = 'interpretation only';
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[0].metricAssertion')).toBe(
        true,
      );
    }
  });

  it('rejects derived_metric evidence without a metric query', () => {
    const document = minimalProposal() as Record<string, unknown>;
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
    const document = minimalProposal() as Record<string, unknown>;
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
    const document = minimalProposal() as Record<string, unknown>;
    document['assetUrls'] = ['http://assets.kyneloom.local/tenants/demo-org/x.svg'];
    const result = parseMomentProposal(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'assetUrls[0]')).toBe(true);
    }
  });

  it('rejects an end-before-start window', () => {
    const document = minimalProposal() as Record<string, unknown>;
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
