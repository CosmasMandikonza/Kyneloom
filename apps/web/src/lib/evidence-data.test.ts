import { describe, expect, it } from 'vitest';
import {
  computeSeparation,
  SEPARATION_ALGORITHM_VERSION,
  verifySeparationEvidence,
} from '@kyneloom/match-core';
import { loadGoldenMatch } from './match-fixture';
import {
  buildEvidenceProjection,
  DECOY_RUNNER_ID,
  SEPARATION_INPUT,
  validateEvidenceProjection,
} from './evidence-data';

/**
 * KYN-08 acceptance: the UI's evidence object IS the authoritative metric
 * object — computed by `separationFromTimeline`, re-verified with KYN-04
 * dependency semantics, projected verbatim, and validated fail-closed on
 * the client. No hardcoded numbers, no rounded narrative substitutes.
 */

const GOLDEN_VALUES = { before: 6.306, after: 20.344, delta: 14.038 } as const;

describe('buildEvidenceProjection (golden fixture)', () => {
  it('derives the measurement from the authoritative metric — equality, not proximity', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const projection = buildEvidenceProjection(golden);
    expect(projection.status).toBe('verified');

    const direct = computeSeparation(golden.data.projected.acceptedTracking, SEPARATION_INPUT);
    expect(direct.ok).toBe(true);
    if (projection.status !== 'verified' || !direct.ok) return;

    // Byte-for-byte equality with the reducer's own metric object.
    expect(projection.evidence).toEqual(direct.evidence);
    expect(projection.evidence.separationBeforeM).toBe(GOLDEN_VALUES.before);
    expect(projection.evidence.separationAfterM).toBe(GOLDEN_VALUES.after);
    // The fixture narrative rounds to 14.037 — the computed fact is 14.038
    // and must NOT be silently replaced.
    expect(projection.evidence.deltaM).toBe(GOLDEN_VALUES.delta);
    expect(projection.evidence.deltaM).not.toBe(14.037);
  });

  it('carries algorithm version, window, frame ids, fingerprint, classification', async () => {
    const golden = await loadGoldenMatch();
    const projection = buildEvidenceProjection(golden);
    if (projection.status !== 'verified') throw new Error('must be verified');
    const e = projection.evidence;
    expect(e.algorithmVersion).toBe(SEPARATION_ALGORITHM_VERSION);
    expect(e.matchId).toBe('synthetic-derby-01');
    expect(e.defenderId).toBe('away-03');
    expect(e.strikerId).toBe('home-09');
    expect(e.fromMs).toBe(4_720_500);
    expect(e.toMs).toBe(4_724_000);
    expect(e.beforeSourceFrameIds).toEqual(['frame-47205', 'frame-47205']);
    expect(e.afterSourceFrameIds).toEqual(['frame-47240', 'frame-47240']);
    expect(e.inputFingerprint).toBe('bedfe2a5');
    expect(e.basis).toBe('synthetic_ground_truth');
    expect(e.classification).toBe('calculated');
    expect(e.hypothesisBoundary).toContain('hypothesis');
  });

  it('exposes exactly the endpoint poses the overlay anchors on (exact frames)', async () => {
    const golden = await loadGoldenMatch();
    const projection = buildEvidenceProjection(golden);
    if (projection.status !== 'verified') throw new Error('must be verified');
    expect(projection.endpoints).toHaveLength(4);
    for (const endpoint of projection.endpoints) {
      expect(endpoint.exact).toBe(true);
      expect(endpoint.sourceFrameId).toMatch(/^frame-47(205|240)$/);
      expect(Number.isFinite(endpoint.xM)).toBe(true);
      expect(Number.isFinite(endpoint.yM)).toBe(true);
    }
  });

  it('grounds the decoy trail in actual runner samples inside the window', async () => {
    const golden = await loadGoldenMatch();
    const projection = buildEvidenceProjection(golden);
    if (projection.status !== 'verified') throw new Error('must be verified');
    expect(projection.runnerTrail.length).toBeGreaterThanOrEqual(2);
    for (const sample of projection.runnerTrail) {
      expect(sample.tMs).toBeGreaterThanOrEqual(SEPARATION_INPUT.fromMs);
      expect(sample.tMs).toBeLessThanOrEqual(SEPARATION_INPUT.toMs);
    }
    expect(DECOY_RUNNER_ID).toBe('home-11');
  });

  it('is JSON-serializable across the server→client boundary', async () => {
    const golden = await loadGoldenMatch();
    const projection = buildEvidenceProjection(golden);
    expect(() => JSON.stringify(projection)).not.toThrow();
    const revived = JSON.parse(JSON.stringify(projection));
    expect(revived).toEqual(projection);
  });
});

describe('validateEvidenceProjection (fail-closed client gate)', () => {
  it('accepts the genuine projection round-tripped through JSON', async () => {
    const golden = await loadGoldenMatch();
    const projection = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as unknown;
    expect(validateEvidenceProjection(projection)?.status).toBe('verified');
  });

  const corruptions: readonly [name: string, mutate: (p: Record<string, unknown>) => void][] = [
    [
      'measurement replaced by a fabricated number',
      (p) => void ((p.evidence as Record<string, unknown>).deltaM = 99.999),
    ],
    [
      'missing fingerprint',
      (p) => void delete (p.evidence as Record<string, unknown>).inputFingerprint,
    ],
    [
      'wrong algorithm version',
      (p) => void ((p.evidence as Record<string, unknown>).algorithmVersion = 'evil-metric-v9'),
    ],
    ['missing endpoint pose', (p) => void (p.endpoints as unknown[]).pop()],
    [
      'endpoint downgraded from exact',
      (p) => void ((p.endpoints as Record<string, unknown>[])[0]!.exact = false),
    ],
    [
      'empty source frame id',
      (p) =>
        void ((p.evidence as Record<string, unknown>).beforeSourceFrameIds = ['', 'frame-47205']),
    ],
    ['trail with a single sample', (p) => void (p.runnerTrail as unknown[]).splice(1)],
    [
      'NaN coordinate',
      (p) => void ((p.endpoints as Record<string, unknown>[])[0]!.xM = Number.NaN),
    ],
    [
      'interpretation reclassified as verified fact',
      (p) => void ((p.interpretation as Record<string, unknown>).classification = 'calculated'),
    ],
  ];

  for (const [name, mutate] of corruptions) {
    it(`rejects: ${name}`, async () => {
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      mutate(raw);
      expect(validateEvidenceProjection(raw)).toBeNull();
    });
  }

  it('rejects non-object payloads outright', () => {
    expect(validateEvidenceProjection(null)).toBeNull();
    expect(validateEvidenceProjection('verified')).toBeNull();
    expect(validateEvidenceProjection(42)).toBeNull();
  });
});

describe('unverified projections (adversarial evidence states)', () => {
  it('withholds the measurement when an endpoint entity has no exact frame', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const clone = JSON.parse(JSON.stringify(golden)) as typeof golden;
    if (!clone.ok) return;
    // Drop every away-03 sample at the window start: exact measurement
    // becomes impossible — the metric must refuse, not interpolate.
    (
      clone.data.projected as { acceptedTracking: typeof clone.data.projected.acceptedTracking }
    ).acceptedTracking = clone.data.projected.acceptedTracking.filter(
      (s) => !(s.entityId === 'away-03' && s.sampleTimeMs === SEPARATION_INPUT.fromMs),
    );
    const projection = buildEvidenceProjection(clone);
    expect(projection.status).toBe('unverified');
    if (projection.status !== 'unverified') return;
    expect(projection.reason).toContain('away-03');
  });

  it('a dependency-changing correction invalidates the OLD evidence and yields a different measurement (KYN-04)', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const original = buildEvidenceProjection(golden);
    if (original.status !== 'verified') throw new Error('original must be verified');

    const clone = JSON.parse(JSON.stringify(golden)) as typeof golden;
    if (!clone.ok) return;
    // A tracking correction moves the defender in a dependency frame.
    for (const sample of clone.data.projected.acceptedTracking) {
      if (sample.entityId === 'away-03' && sample.sampleTimeMs === SEPARATION_INPUT.toMs) {
        sample.xM += 0.5;
      }
    }
    // KYN-04 invalidation: the ORIGINAL record no longer verifies against
    // the corrected tracking — its fingerprint pinned the old frame.
    expect(verifySeparationEvidence(original.evidence, clone.data.projected.acceptedTracking)).toBe(
      false,
    );
    // Live re-derivation produces a NEW verified measurement with a new
    // fingerprint and a different number — truthful, never the stale one.
    const rederived = buildEvidenceProjection(clone);
    expect(rederived.status).toBe('verified');
    if (rederived.status !== 'verified') return;
    expect(rederived.evidence.inputFingerprint).not.toBe(original.evidence.inputFingerprint);
    expect(rederived.evidence.separationAfterM).not.toBe(original.evidence.separationAfterM);
  });

  it('stays verified for a correction that does NOT touch the dependencies', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const clone = JSON.parse(JSON.stringify(golden)) as typeof golden;
    if (!clone.ok) return;
    // Move an unrelated player (home-05) outside the window's dependencies.
    for (const sample of clone.data.projected.acceptedTracking) {
      if (sample.entityId === 'home-05' && sample.sampleTimeMs === SEPARATION_INPUT.toMs) {
        sample.xM += 1.5;
      }
    }
    const projection = buildEvidenceProjection(clone);
    expect(projection.status).toBe('verified');
    if (projection.status !== 'verified') return;
    // And the measurement itself is unchanged.
    expect(projection.evidence.deltaM).toBe(GOLDEN_VALUES.delta);
  });
});
