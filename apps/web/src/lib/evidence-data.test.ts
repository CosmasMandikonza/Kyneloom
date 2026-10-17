import { describe, expect, it } from 'vitest';
import {
  computeSeparation,
  createTimeline,
  SEPARATION_ALGORITHM_VERSION,
  verifySeparationEvidence,
} from '@kyneloom/match-core';
import { loadGoldenMatch } from './match-fixture';
import {
  buildEvidenceProjection,
  DECOY_RUNNER_ID,
  SEPARATION_INPUT,
  SOURCE_QUALITY_POLICY,
  validateEvidenceProjection,
  type EvidenceValidationContext,
} from './evidence-data';

/**
 * KYN-08 acceptance: the UI's evidence object IS the authoritative metric
 * object — computed by `separationFromTimeline`, re-verified with KYN-04
 * dependency semantics, gated by the documented source-quality policy,
 * projected verbatim, and validated fail-closed on the client against the
 * scene's OWN timeline + accepted tracking. No hardcoded numbers, no
 * rounded narrative substitutes, no plausible-but-falsified payloads.
 */

const GOLDEN_VALUES = { before: 6.306, after: 20.344, delta: 14.038 } as const;

async function goldenContext(): Promise<EvidenceValidationContext> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('golden fixture unavailable');
  const tracking = golden.data.projected.acceptedTracking;
  return { matchId: 'synthetic-derby-01', timeline: createTimeline(tracking), tracking };
}

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

  it('the golden endpoints satisfy the documented source-quality policy', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    for (const sample of golden.data.projected.acceptedTracking) {
      if (
        (sample.entityId === SEPARATION_INPUT.defenderId ||
          sample.entityId === SEPARATION_INPUT.strikerId) &&
        (sample.sampleTimeMs === SEPARATION_INPUT.fromMs ||
          sample.sampleTimeMs === SEPARATION_INPUT.toMs)
      ) {
        expect(sample.confidence).toBeGreaterThanOrEqual(
          SOURCE_QUALITY_POLICY.minEndpointConfidence,
        );
        expect(sample.visibility).toBe('tracked');
        expect(sample.origin).toBe('synthetic_ground_truth');
      }
    }
  });
});

describe('source-quality gate (raw endpoint records decide)', () => {
  const withEndpointMutation = async (
    mutate: (sample: Record<string, unknown>, entityId: string, tMs: number) => boolean,
  ) => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) throw new Error('golden unavailable');
    const clone = JSON.parse(JSON.stringify(golden)) as typeof golden;
    if (!clone.ok) throw new Error('clone failed');
    for (const sample of clone.data.projected.acceptedTracking as unknown as Record<
      string,
      unknown
    >[]) {
      if (
        (sample.entityId === SEPARATION_INPUT.defenderId ||
          sample.entityId === SEPARATION_INPUT.strikerId) &&
        (sample.sampleTimeMs === SEPARATION_INPUT.fromMs ||
          sample.sampleTimeMs === SEPARATION_INPUT.toMs)
      ) {
        mutate(sample, sample.entityId as string, sample.sampleTimeMs as number);
      }
    }
    return buildEvidenceProjection(clone);
  };

  it('withholds when an endpoint confidence is below the threshold', async () => {
    const projection = await withEndpointMutation((sample, id) => {
      if (id === SEPARATION_INPUT.defenderId) sample.confidence = 0.42;
      return true;
    });
    expect(projection.status).toBe('unverified');
    if (projection.status !== 'unverified') return;
    expect(projection.reason).toContain('confidence');
    expect(projection.reason).toContain('0.42');
    expect(projection.reason).toContain('below the supported threshold');
  });

  it('withholds when an endpoint visibility is partial (reconstructed)', async () => {
    const projection = await withEndpointMutation((sample, id) => {
      if (id === SEPARATION_INPUT.strikerId) sample.visibility = 'partial';
      return true;
    });
    expect(projection.status).toBe('unverified');
    if (projection.status !== 'unverified') return;
    expect(projection.reason).toContain('visibility');
    expect(projection.reason).toContain('home-09');
  });

  it('withholds observed/mixed provenance instead of mislabeling it synthetic ground truth', async () => {
    const projection = await withEndpointMutation((sample, id) => {
      if (id === SEPARATION_INPUT.defenderId) sample.origin = 'source_observed';
      return true;
    });
    expect(projection.status).toBe('unverified');
    if (projection.status !== 'unverified') return;
    expect(projection.reason).toContain('source_observed');
    expect(projection.reason).toContain('withheld rather than relabeled');
  });

  it('withholds ambiguous endpoint identity (duplicate accepted samples)', async () => {
    const golden = await loadGoldenMatch();
    if (!golden.ok) return;
    const clone = JSON.parse(JSON.stringify(golden)) as typeof golden;
    if (!clone.ok) return;
    const tracking = clone.data.projected.acceptedTracking as unknown as Array<
      Record<string, unknown>
    >;
    const original = tracking.find(
      (s) =>
        s.entityId === SEPARATION_INPUT.defenderId && s.sampleTimeMs === SEPARATION_INPUT.fromMs,
    )!;
    tracking.push({ ...original, xM: (original.xM as number) + 3 });
    const projection = buildEvidenceProjection(clone);
    expect(projection.status).toBe('unverified');
    if (projection.status !== 'unverified') return;
    expect(projection.reason).toContain('ambiguous');
  });

  it('keeps the untouched golden measurement verified (6.306 → 20.344, +14.038)', async () => {
    const golden = await loadGoldenMatch();
    const projection = buildEvidenceProjection(golden);
    if (projection.status !== 'verified') throw new Error('golden must stay verified');
    expect(projection.evidence.separationBeforeM).toBe(GOLDEN_VALUES.before);
    expect(projection.evidence.separationAfterM).toBe(GOLDEN_VALUES.after);
    expect(projection.evidence.deltaM).toBe(GOLDEN_VALUES.delta);
  });
});

describe('validateEvidenceProjection (fail-closed client gate)', () => {
  it('accepts the genuine projection round-tripped through JSON', async () => {
    const ctx = await goldenContext();
    const golden = await loadGoldenMatch();
    const projection = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as unknown;
    const validated = validateEvidenceProjection(projection, ctx);
    expect(validated?.status).toBe('verified');
    if (validated?.status !== 'verified') return;
    expect(validated.evidence.separationBeforeM).toBe(GOLDEN_VALUES.before);
    expect(validated.evidence.deltaM).toBe(GOLDEN_VALUES.delta);
  });

  it('rejects a projection for a different match than the scene', async () => {
    const ctx = await goldenContext();
    const golden = await loadGoldenMatch();
    const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
      string,
      unknown
    >;
    (raw.evidence as Record<string, unknown>).matchId = 'another-match-99';
    expect(validateEvidenceProjection(raw, ctx)).toBeNull();
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
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      mutate(raw);
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });
  }

  it('rejects non-object payloads outright without throwing', async () => {
    const ctx = await goldenContext();
    for (const bad of [null, undefined, 'verified', 42, true, [], () => {}]) {
      expect(validateEvidenceProjection(bad, ctx)).toBeNull();
    }
  });

  const malformations: readonly [name: string, mutate: (p: Record<string, unknown>) => void][] = [
    ['evidence is null', (p) => void (p.evidence = null)],
    ['evidence is a string', (p) => void (p.evidence = 'verified')],
    ['evidence is missing', (p) => void delete p.evidence],
    [
      'beforeSourceFrameIds is an object',
      (p) =>
        void ((p.evidence as Record<string, unknown>).beforeSourceFrameIds = { 0: 'frame-47205' }),
    ],
    [
      'beforeSourceFrameIds is a string',
      (p) => void ((p.evidence as Record<string, unknown>).beforeSourceFrameIds = 'frame-47205'),
    ],
    ['dependsOn is null', (p) => void ((p.evidence as Record<string, unknown>).dependsOn = null)],
    [
      'dependsOn.sourceFrameIds too short',
      (p) =>
        void ((
          (p.evidence as Record<string, unknown>).dependsOn as Record<string, unknown>
        ).sourceFrameIds = ['frame-47205']),
    ],
    ['endpoints contains null', (p) => void ((p.endpoints as unknown[])[1] = null)],
    ['endpoints is an object not an array', (p) => void (p.endpoints = { length: 4 })],
    ['runnerTrail contains null', (p) => void ((p.runnerTrail as unknown[])[0] = null)],
    ['interpretation is null', (p) => void (p.interpretation = null)],
    ['interpretation is a string', (p) => void (p.interpretation = 'hypothesis')],
    [
      'deltaM is a numeric string',
      (p) => void ((p.evidence as Record<string, unknown>).deltaM = '14.038'),
    ],
    [
      'fromMs is +Infinity',
      (p) => void ((p.evidence as Record<string, unknown>).fromMs = Number.POSITIVE_INFINITY),
    ],
    [
      'fromMs is a non-integer float',
      (p) => void ((p.evidence as Record<string, unknown>).fromMs = 4720500.5),
    ],
    [
      'window inverted (toMs <= fromMs)',
      (p) => void ((p.evidence as Record<string, unknown>).toMs = 4720500),
    ],
    [
      'sourceFrameId not a frame pattern',
      (p) => void ((p.endpoints as Record<string, unknown>[])[0]!.sourceFrameId = 'frame-abc'),
    ],
    [
      'reason missing on an unverified projection',
      (p) => void ((p as Record<string, unknown>).status = 'unverified'),
    ],
  ];

  for (const [name, mutate] of malformations) {
    it(`never throws and rejects: ${name}`, async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      mutate(raw);
      let result: unknown = 'unset';
      expect(() => {
        result = validateEvidenceProjection(raw, ctx);
      }).not.toThrow();
      expect(result).toBeNull();
    });
  }

  it('rejects random unknown garbage without throwing', async () => {
    const ctx = await goldenContext();
    const garbage: unknown[] = [
      { status: 'verified', evidence: { beforeSourceFrameIds: [] } },
      { status: 'verified' },
      { status: 1 },
      { status: null },
      { status: 'verified', evidence: [], endpoints: 'x' },
      { status: 'verified', evidence: { deltaM: 14.038 }, endpoints: [1, 2, 3, 4] },
      Object.create(null),
      new Date(0),
    ];
    for (const payload of garbage) {
      expect(() => validateEvidenceProjection(payload, ctx)).not.toThrow();
      expect(validateEvidenceProjection(payload, ctx)).toBeNull();
    }
  });

  describe('plausible but falsified source references (arithmetic-consistent forgeries)', () => {
    it('rejects endpoint identities swapped between defender and striker', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      const eps = raw.endpoints as Record<string, unknown>[];
      const first = eps[0]!.entityId;
      eps[0]!.entityId = eps[1]!.entityId;
      eps[1]!.entityId = first; // distances between the same points: unchanged
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });

    it('rejects a forged endpoint frame id that exists elsewhere in the fixture', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      // frame-47206 is a real frame — but not this endpoint's source.
      (raw.endpoints as Record<string, unknown>[])[0]!.sourceFrameId = 'frame-47206';
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });

    it('rejects an arbitrary fingerprint string on an otherwise genuine payload', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      (raw.evidence as Record<string, unknown>).inputFingerprint = 'deadbeef';
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });

    it('rejects a fully self-consistent measurement for a DIFFERENT (shifted) window', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      if (!golden.ok) return;
      // Build a genuine metric object for a different exact-frame window —
      // internally perfect, arithmetically consistent, but not the moment
      // this product claims to measure.
      const shifted = computeSeparation(golden.data.projected.acceptedTracking, {
        ...SEPARATION_INPUT,
        fromMs: SEPARATION_INPUT.fromMs + 100,
        toMs: SEPARATION_INPUT.toMs + 100,
      });
      if (!shifted.ok) return;
      const raw = JSON.parse(JSON.stringify(shifted.evidence)) as Record<string, unknown>;
      const payload = {
        status: 'verified',
        evidence: raw,
        endpoints: [
          {
            entityId: shifted.evidence.defenderId,
            xM: 0,
            yM: 0,
            sourceFrameId: 'frame-47206',
            exact: true,
          },
          {
            entityId: shifted.evidence.strikerId,
            xM: shifted.evidence.separationBeforeM,
            yM: 0,
            sourceFrameId: 'frame-47206',
            exact: true,
          },
          {
            entityId: shifted.evidence.defenderId,
            xM: 0,
            yM: 0,
            sourceFrameId: 'frame-47241',
            exact: true,
          },
          {
            entityId: shifted.evidence.strikerId,
            xM: shifted.evidence.separationAfterM,
            yM: 0,
            sourceFrameId: 'frame-47241',
            exact: true,
          },
        ],
        runnerTrail: [
          { tMs: SEPARATION_INPUT.fromMs, xM: 0, yM: 0 },
          { tMs: SEPARATION_INPUT.fromMs + 100, xM: 1, yM: 0 },
        ],
        interpretation: {
          text: 'plausible story',
          classification: 'hypothesis',
          boundary: shifted.evidence.hypothesisBoundary,
        },
      };
      expect(validateEvidenceProjection(payload, ctx)).toBeNull();
    });

    it('rejects endpoints moved to reproduce shifted but delta-consistent distances', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      const e = raw.evidence as Record<string, unknown>;
      const eps = raw.endpoints as Record<string, unknown>[];
      // Stretch both distances by exactly 1 m — delta unchanged (14.038),
      // all arithmetic still consistent, but coordinates no longer match the
      // authoritative timeline samples.
      const before = shiftedPair(
        eps[0] as { xM: number; yM: number },
        eps[1] as { xM: number; yM: number },
        1,
      );
      const after = shiftedPair(
        eps[2] as { xM: number; yM: number },
        eps[3] as { xM: number; yM: number },
        1,
      );
      eps[0]!.xM = before.a.xM;
      eps[0]!.yM = before.a.yM;
      eps[1]!.xM = before.b.xM;
      eps[1]!.yM = before.b.yM;
      eps[2]!.xM = after.a.xM;
      eps[2]!.yM = after.a.yM;
      eps[3]!.xM = after.b.xM;
      eps[3]!.yM = after.b.yM;
      e.separationBeforeM = before.distance;
      e.separationAfterM = after.distance;
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });

    it('rejects a tampered hypothesis boundary (verified-cause language)', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      const raw = JSON.parse(JSON.stringify(buildEvidenceProjection(golden))) as Record<
        string,
        unknown
      >;
      (raw.interpretation as Record<string, unknown>).boundary =
        'The winger definitely caused the space — verified causation.';
      expect(validateEvidenceProjection(raw, ctx)).toBeNull();
    });

    it('rejects the genuine projection against a MISMATCHED scene context', async () => {
      const golden = await loadGoldenMatch();
      if (!golden.ok) return;
      const projection = JSON.parse(JSON.stringify(buildEvidenceProjection(golden)));
      // A tracking correction on a dependency frame: the scene no longer
      // supports this evidence, so the client gate must reject it.
      const corrected = golden.data.projected.acceptedTracking.map((sample) =>
        sample.entityId === SEPARATION_INPUT.defenderId &&
        sample.sampleTimeMs === SEPARATION_INPUT.toMs
          ? { ...sample, xM: sample.xM + 0.5 }
          : sample,
      );
      const mismatchedCtx: EvidenceValidationContext = {
        matchId: 'synthetic-derby-01',
        timeline: createTimeline(corrected),
        tracking: corrected,
      };
      expect(validateEvidenceProjection(projection, mismatchedCtx)).toBeNull();
    });

    it('accepts the genuine projection against its own scene context (KYN-04 verify passes)', async () => {
      const ctx = await goldenContext();
      const golden = await loadGoldenMatch();
      if (!golden.ok) return;
      const evidence = buildEvidenceProjection(golden);
      if (evidence.status !== 'verified') return;
      expect(verifySeparationEvidence(evidence.evidence, ctx.tracking)).toBe(true);
    });
  });
});

function shiftedPair(
  a: { xM: number; yM: number },
  b: { xM: number; yM: number },
  growM: number,
): { a: { xM: number; yM: number }; b: { xM: number; yM: number }; distance: number } {
  const dx = b.xM - a.xM;
  const dy = b.yM - a.yM;
  const len = Math.hypot(dx, dy);
  const target = Math.round((len + growM) * 1000) / 1000;
  const scale = target / len;
  const nb = {
    xM: Math.round((a.xM + dx * scale) * 1000) / 1000,
    yM: Math.round((a.yM + dy * scale) * 1000) / 1000,
  };
  const distance = Math.round(Math.hypot(nb.xM - a.xM, nb.yM - a.yM) * 1000) / 1000;
  // Keep the pair distance exactly the rounded target for the arithmetic layer.
  const adjusted = {
    xM: a.xM + (nb.xM - a.xM) * (target / distance),
    yM: a.yM + (nb.yM - a.yM) * (target / distance),
  };
  return {
    a,
    b: { xM: Math.round(adjusted.xM * 1000) / 1000, yM: Math.round(adjusted.yM * 1000) / 1000 },
    distance: target,
  };
}

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
