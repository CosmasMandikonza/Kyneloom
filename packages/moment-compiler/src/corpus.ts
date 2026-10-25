import { executeMetricQuery, parseMetricQuery, type MomentCandidate } from '@kyneloom/match-core';
import type { MomentProposal } from '@kyneloom/contracts';
import { metricToolContextFrom, type CompilerSourceContext } from './source-context';

/**
 * The deterministic local proposal corpus (KYN-16, proposal schema v0.2.0).
 *
 * Every document here is labeled `origin: 'local-deterministic'`: it is
 * committed demo/test corpus material produced by deterministic code against
 * the committed golden fixture — it is NOT, and must never be presented as,
 * a Microsoft Foundry agent output (KYN-15 owns that boundary).
 *
 * The golden proposal is a WELL-BEHAVED agent under the text law: verified
 * claims carry references (a metric assertion / a source event), never
 * prose; the compiler generates the factual sentences; the only authored
 * text is the number-free hypothesis interpretation and the number-free
 * recap headline. `broadcast-sweep` is a second VALID variant with a
 * different camera, headline and caption timing — the live proof that
 * recompiling changes the audience experience (review blocker C). The
 * defect variants are small, labeled mutations — each demonstrates a
 * specific compiler rejection (the docs/07 "grand-prize failure
 * demonstration" among them).
 */

export interface CorpusEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** What the compiler must do with this entry (asserted by tests). */
  readonly expect: 'valid' | 'invalid';
  readonly expectedCode?: string;
  readonly proposal: MomentProposal;
}

export interface CompileCorpus {
  readonly candidate: MomentCandidate;
  readonly golden: MomentProposal;
  readonly entries: readonly CorpusEntry[];
}

/** Pick the deterministic hero candidate: the top-scored detection. */
export function selectHeroCandidate(source: CompilerSourceContext): MomentCandidate {
  const candidate = source.candidates[0];
  if (candidate === undefined) {
    throw new Error(
      'no moment candidates detected for this source — the corpus cannot be grounded',
    );
  }
  return candidate;
}

function verifiedSeparationDelta(
  source: CompilerSourceContext,
  fromMs: number,
  toMs: number,
): { readonly beforeM: number; readonly afterM: number; readonly deltaM: number } {
  const parsed = parseMetricQuery({
    kind: 'separation-delta',
    defenderId: 'away-03',
    strikerId: 'home-09',
    fromMs,
    toMs,
  });
  if (!parsed.ok) throw new Error(`corpus separation query rejected: ${parsed.code}`);
  const executed = executeMetricQuery(metricToolContextFrom(source), parsed.query);
  if (!executed.ok || executed.result.status !== 'verified') {
    throw new Error('corpus separation metric is not verified for the hero candidate window');
  }
  const value = executed.result.value as {
    beforeM: number;
    afterM: number;
    deltaM: number;
  };
  return { beforeM: value.beforeM, afterM: value.afterM, deltaM: value.deltaM };
}

/** The separation evidence's REAL dependency frames (a well-behaved agent asked for provenance). */
function separationInputRefs(
  source: CompilerSourceContext,
  fromMs: number,
  toMs: number,
): string[] {
  const parsed = parseMetricQuery({
    kind: 'separation-delta',
    defenderId: 'away-03',
    strikerId: 'home-09',
    fromMs,
    toMs,
  });
  if (!parsed.ok) throw new Error(`corpus query rejected: ${parsed.code}`);
  const executed = executeMetricQuery(metricToolContextFrom(source), parsed.query);
  if (!executed.ok || executed.result.status !== 'verified') {
    throw new Error('corpus separation metric is not verified');
  }
  return [
    ...new Set([
      ...executed.result.provenance.dependsOn.sourceFrameIds,
      ...executed.result.provenance.dependsOn.eventIds,
    ]),
  ].sort();
}

function separationEvidence(candidate: {
  readonly startMs: number;
  readonly endMs: number;
}): MomentProposal['evidence'][number] {
  return {
    id: 'ev-separation',
    kind: 'derived_metric',
    ref: 'metric-separation-away-03-home-09',
    metricQuery: {
      kind: 'separation-delta',
      args: {
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: candidate.startMs,
        toMs: candidate.endMs,
      },
    },
    inputRefs: [],
  };
}

/** Deterministic camera sequence (pitch meters, z up) for the hero window. */
function heroCameraTrack(windowMs: number): MomentProposal['cameraTracks'] {
  return [
    {
      id: 'cam-compiled-sequence',
      mode: 'directed',
      startMs: 0,
      endMs: windowMs,
      keyframes: [
        { tMs: 0, position: [-18, -30, 26], target: [10, -6, 0], fovDeg: 46 },
        {
          tMs: Math.round(windowMs * 0.28),
          position: [-4, -22, 17],
          target: [14, -8, 1],
          fovDeg: 42,
        },
        {
          tMs: Math.round(windowMs * 0.55),
          position: [8, -12, 12],
          target: [22, -6, 1],
          fovDeg: 40,
        },
        {
          tMs: Math.round(windowMs * 0.78),
          position: [28, -22, 12],
          target: [42, -8, 1],
          fovDeg: 38,
        },
        { tMs: windowMs, position: [38, -30, 15], target: [46, -5, 1.2], fovDeg: 44 },
      ],
    },
  ];
}

/** A second deterministic sequence: high broadcast sweep instead of the pitch-level ride. */
function sweepCameraTrack(windowMs: number): MomentProposal['cameraTracks'] {
  return [
    {
      id: 'cam-broadcast-sweep',
      mode: 'directed',
      startMs: 0,
      endMs: windowMs,
      keyframes: [
        { tMs: 0, position: [-40, -18, 30], target: [4, -4, 0], fovDeg: 44 },
        {
          tMs: Math.round(windowMs * 0.5),
          position: [0, -26, 34],
          target: [18, -6, 0],
          fovDeg: 40,
        },
        { tMs: windowMs, position: [30, -34, 28], target: [44, -6, 0], fovDeg: 42 },
      ],
    },
  ];
}

export function buildCompileCorpus(source: CompilerSourceContext): CompileCorpus {
  const candidate = selectHeroCandidate(source);
  const windowMs = candidate.endMs - candidate.startMs;
  // A well-behaved agent asked get_metric for the separation over exactly
  // the candidate's own window — and quotes what the tool returned.
  const separation = verifiedSeparationDelta(source, candidate.startMs, candidate.endMs);

  const golden: MomentProposal = {
    schemaVersion: '0.2.0',
    proposalId: 'invisible-assist-directed-v1',
    origin: 'local-deterministic',
    originNote:
      'Deterministic local corpus proposal for the committed synthetic golden fixture — not a Microsoft Foundry agent output.',
    tenantId: source.tenantId,
    matchId: source.matchId,
    candidateRef: candidate.candidateId,
    basedOn: { reducerRevision: source.reducerRevision, sourceHash: source.sourceHash },
    timeRangeMs: [candidate.startMs, candidate.endMs],
    tools: ['get_metric', 'validate_camera_plan', 'validate_claims'],
    cameraTracks: heroCameraTrack(windowMs),
    overlays: [
      {
        id: 'ov-separation',
        kind: 'distance',
        startMs: Math.round(windowMs * 0.1),
        endMs: Math.round(windowMs * 0.75),
        evidenceIds: ['ev-separation'],
      },
      {
        id: 'ov-reception',
        kind: 'event_marker',
        startMs: Math.max(0, Math.round(windowMs * 0.72)),
        endMs: Math.min(windowMs, Math.round(windowMs * 0.72) + 1200),
        evidenceIds: ['ev-reception'],
      },
      {
        id: 'ov-caption-reading',
        kind: 'caption',
        startMs: Math.round(windowMs * 0.75),
        endMs: windowMs,
        evidenceIds: ['ev-separation'],
      },
    ],
    claims: [
      {
        id: 'claim-separation-grew',
        status: 'calculated',
        evidenceIds: ['ev-separation'],
        language: 'en',
        metricAssertion: {
          kind: 'separation-delta',
          args: {
            defenderId: 'away-03',
            strikerId: 'home-09',
            fromMs: candidate.startMs,
            toMs: candidate.endMs,
          },
          valueField: 'deltaM',
          assertedValue: separation.deltaM,
        },
      },
      {
        id: 'claim-reception',
        status: 'observed',
        evidenceIds: ['ev-reception'],
        language: 'en',
      },
      {
        id: 'claim-run-created-space',
        status: 'hypothesis',
        evidenceIds: ['ev-separation'],
        language: 'en',
        text: "The winger's decoy run likely contributed to the space the finish exploited.",
        inferenceDisclosure:
          'Tactical interpretation from spatial co-occurrence; tracking alone does not establish intent or causation.',
      },
    ],
    evidence: [
      separationEvidence(candidate),
      { id: 'ev-reception', kind: 'source_event', ref: 'evt-0042', inputRefs: ['evt-0042'] },
    ],
    lenses: ['fan', 'analyst', 'accessible'],
    rightsPolicyRef: source.rightsPolicyAllowlist[0] ?? 'synthetic-0bsd-demo-v1',
    assetUrls: [
      `${source.assetUrlPrefixes[0] ?? 'https://assets.kyneloom.local/tenants/demo-org/'}badges/measured.svg`,
    ],
    recapHeadline: 'The run nobody passed to opened the goal',
  };
  golden.evidence[0]!.inputRefs = separationInputRefs(source, candidate.startMs, candidate.endMs);

  // A second VALID moment: same verified facts, a different director's cut —
  // different camera, headline and caption timing (and therefore a different
  // content hash and a visibly different experience).
  const sweep: MomentProposal = {
    ...golden,
    proposalId: 'invisible-assist-broadcast-sweep-v1',
    cameraTracks: sweepCameraTrack(windowMs),
    overlays: golden.overlays.map((overlay) =>
      overlay.id === 'ov-caption-reading'
        ? { ...overlay, startMs: Math.round(windowMs * 0.55), endMs: Math.round(windowMs * 0.9) }
        : overlay,
    ),
    recapHeadline: 'Space made, finish taken',
  };

  const defect = (mutate: (proposal: MomentProposal) => MomentProposal): MomentProposal =>
    mutate(golden);

  const entries: CorpusEntry[] = [
    {
      id: 'golden',
      label: 'Well-formed proposal',
      description:
        'The deterministic local proposal a well-behaved agent could have produced: references instead of prose, numbers quoted from get_metric, real dependency frames, one hypothesis with disclosure.',
      expect: 'valid',
      proposal: golden,
    },
    {
      id: 'broadcast-sweep',
      label: 'Second valid cut — broadcast sweep',
      description:
        'Same verified facts, a different director: high sweep camera, different headline and caption timing. Compiles to a different hash — and the stage plays THIS cut.',
      expect: 'valid',
      proposal: sweep,
    },
    {
      id: 'defect-false-distance',
      label: 'False distance claim',
      description:
        'The claim asserts the striker–defender gap ended at 14.000 m. The deterministic recomputation disagrees — the number dies at compile time.',
      expect: 'invalid',
      expectedCode: 'unsupported_claim',
      proposal: defect((p) => ({
        ...p,
        claims: p.claims.map((claim) =>
          claim.status === 'calculated' && claim.metricAssertion !== undefined
            ? {
                ...claim,
                metricAssertion: {
                  ...claim.metricAssertion,
                  valueField: 'afterM',
                  assertedValue: 14,
                },
              }
            : claim,
        ),
      })),
    },
    {
      id: 'defect-prose-bypass',
      label: 'Prose instead of proof',
      description:
        'A calculated claim whose only support is the sentence "The defender was exactly 14 metres away." — no metric assertion, and text proposed on a verified claim. Both are rejected.',
      expect: 'invalid',
      proposal: defect((p) => ({
        ...p,
        claims: p.claims.map((claim) =>
          claim.status === 'calculated'
            ? {
                ...claim,
                text: 'The defender was exactly 14 metres away.',
                metricAssertion: undefined,
              }
            : claim,
        ),
      })),
    },
    {
      id: 'defect-contradictory-prose',
      label: 'Contradictory prose beside a correct assertion',
      description:
        'The metric assertion is correct, but the proposal also tries to attach prose asserting a different number. Verified text is compiler-generated — proposed text on a calculated claim is rejected outright.',
      expect: 'invalid',
      proposal: defect((p) => ({
        ...p,
        claims: p.claims.map((claim) =>
          claim.status === 'calculated'
            ? { ...claim, text: '…and the defender was exactly 14 metres away.' }
            : claim,
        ),
      })),
    },
    {
      id: 'defect-numeric-headline',
      label: 'Numeric headline',
      description:
        'The recap headline asserts "The 14-metre gap that won it". Headlines are editorial and number-free — verified numbers live in compiler-generated claims.',
      expect: 'invalid',
      proposal: defect((p) => ({ ...p, recapHeadline: 'The 14-metre gap that won it' })),
    },
    {
      id: 'defect-observed-cites-metric',
      label: 'Observed claim citing a measurement',
      description:
        'An observed claim must BE a cited source event; this one cites the derived separation metric instead. The generated event sentence cannot be grounded.',
      expect: 'invalid',
      expectedCode: 'missing_reference',
      proposal: defect((p) => ({
        ...p,
        claims: p.claims.map((claim) =>
          claim.status === 'observed' ? { ...claim, evidenceIds: ['ev-separation'] } : claim,
        ),
      })),
    },
    {
      id: 'defect-stale-revision',
      label: 'Stale source revision',
      description:
        'The proposal was built against an older reducer revision — a source correction landed since. Every derived validation is stale.',
      expect: 'invalid',
      expectedCode: 'stale_revision',
      proposal: defect((p) => ({
        ...p,
        basedOn: { ...p.basedOn, reducerRevision: p.basedOn.reducerRevision + 1 },
      })),
    },
    {
      id: 'defect-source-correction',
      label: 'Source content changed',
      description:
        'The source content hash no longer matches the accepted corpus — the tracking was corrected after this proposal was derived.',
      expect: 'invalid',
      expectedCode: 'stale_revision',
      proposal: defect((p) => ({
        ...p,
        basedOn: {
          ...p.basedOn,
          sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      })),
    },
    {
      id: 'defect-unknown-tool',
      label: 'Unknown executable command',
      description:
        'The agent claims to have used "run_sql" — not on the read-only allowlist. No tool outside docs/07 may execute.',
      expect: 'invalid',
      expectedCode: 'unknown_command',
      proposal: defect((p) => ({ ...p, tools: [...p.tools.slice(0, 1), 'run_sql'] })),
    },
    {
      id: 'defect-unsafe-url',
      label: 'Unsafe asset URL',
      description:
        'A javascript: asset URL — the https-only gate rejects it before anything renders.',
      expect: 'invalid',
      proposal: defect((p) => ({ ...p, assetUrls: ['javascript:alert(1)'] })),
    },
    {
      id: 'defect-cross-tenant-asset',
      label: 'Cross-tenant asset',
      description: "A perfectly valid https URL — under a different tenant's asset scope.",
      expect: 'invalid',
      expectedCode: 'cross_tenant_reference',
      proposal: defect((p) => ({
        ...p,
        assetUrls: ['https://assets.kyneloom.local/tenants/other-org/badges/stolen.svg'],
      })),
    },
    {
      id: 'defect-camera-fov',
      label: 'Camera FOV out of range',
      description: 'A keyframe demands a 200° lens. Safe focal bounds are 20–120°.',
      expect: 'invalid',
      proposal: defect((p) => ({
        ...p,
        cameraTracks: p.cameraTracks.map((track) => ({
          ...track,
          keyframes: track.keyframes.map((keyframe, index) =>
            index === 1 ? { ...keyframe, fovDeg: 200 } : keyframe,
          ),
        })),
      })),
    },
    {
      id: 'defect-untracked-entity',
      label: 'Entity the source never tracked',
      description:
        'Evidence cites a separation for home-99 — a player this corpus has never tracked. Missing tracking never becomes invented geometry.',
      expect: 'invalid',
      expectedCode: 'missing_reference',
      proposal: defect((p) => ({
        ...p,
        evidence: p.evidence.map((entry) =>
          entry.kind === 'derived_metric' && entry.metricQuery !== undefined
            ? {
                ...entry,
                metricQuery: {
                  ...entry.metricQuery,
                  args: { ...entry.metricQuery.args, defenderId: 'home-99' },
                },
              }
            : entry,
        ),
        claims: [],
      })),
    },
    {
      id: 'defect-wrong-window',
      label: 'Window drift',
      description:
        'The proposed window does not match the detected candidate — a moment interprets exactly one candidate.',
      expect: 'invalid',
      expectedCode: 'outside_time_window',
      proposal: defect((p) => ({
        ...p,
        timeRangeMs: [p.timeRangeMs[0] + 1000, p.timeRangeMs[1] + 1000] as [number, number],
      })),
    },
    {
      id: 'defect-assertion-without-evidence',
      label: 'Number with no traceable evidence',
      description:
        'The claim asserts a metric its cited evidence never computed — every number must trace to declared, verified evidence.',
      expect: 'invalid',
      expectedCode: 'missing_reference',
      proposal: defect((p) => ({
        ...p,
        claims: p.claims.map((claim) =>
          claim.metricAssertion !== undefined
            ? {
                ...claim,
                metricAssertion: {
                  ...claim.metricAssertion,
                  args: {
                    ...claim.metricAssertion.args,
                    fromMs: (claim.metricAssertion.args.fromMs as number) + 100,
                  },
                },
              }
            : claim,
        ),
      })),
    },
  ];

  return { candidate, golden, entries };
}
