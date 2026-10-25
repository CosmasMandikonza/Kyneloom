import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approvalContentPayload,
  canonicalJsonStringify,
  parseMomentManifest,
  type MatchEvent,
  type TrackingSample,
} from '@kyneloom/contracts';
import {
  createTimeline,
  detectMomentCandidates,
  projectMatch,
  ROSTERS,
} from '@kyneloom/match-core';
import {
  buildCompileCorpus,
  compileMomentProposal,
  metricFactSentence,
  rescaleCameraTrackToWindow,
  type CompilerSourceContext,
  type CompileResult,
} from './index';

/**
 * KYN-16 — the deterministic compiler against the COMMITTED golden fixture.
 * Everything here runs the real pipeline: committed files → authoritative
 * reducer → deterministic candidate detection → corpus → compiler. The
 * acceptance matrix of issue #16 (stale revisions, false claims, missing
 * tracking, fail-closed commands/URLs/tenants, determinism, hash law) is
 * exercised on real data, not mocks.
 */

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../tests/fixtures/generated/synthetic-derby-01',
);

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

interface Corpus {
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
}

function loadRaw(): Corpus {
  const events = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, 'events.json'), 'utf-8'),
  ) as MatchEvent[];
  const tracking = readFileSync(path.join(FIXTURE_DIR, 'tracking.jsonl'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrackingSample);
  return { events, tracking };
}

interface BuiltSource {
  readonly source: CompilerSourceContext;
}

/**
 * Build a trusted source context, optionally from a MUTATED corpus (the
 * source-correction tests). Candidates may be pinned to the pristine
 * detection — the registry row outliving a tracking correction is exactly
 * the real-world stale-compile scenario.
 */
function buildSource(
  corpus: Corpus = loadRaw(),
  options: { readonly pinCandidatesFrom?: Corpus } = {},
): BuiltSource {
  const projected = projectMatch({ matchId: 'synthetic-derby-01', ...corpus });
  const timeline = createTimeline(projected.acceptedTracking);
  const detectionBase =
    options.pinCandidatesFrom === undefined ? corpus : options.pinCandidatesFrom;
  const detection = projectMatch({ matchId: 'synthetic-derby-01', ...detectionBase });
  const candidates = detectMomentCandidates({
    matchId: 'synthetic-derby-01',
    reducerRevision: detection.revisionCount,
    events: detection.acceptedEvents,
    tracking: detection.acceptedTracking,
    timeline: createTimeline(detection.acceptedTracking),
    separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
    movementSubjects: ['home-11'],
    windowMs: [4_717_000, 4_731_000],
  });
  const rolesByEntity = new Map<string, string>();
  for (const team of ['home', 'away'] as const) {
    for (const profile of ROSTERS[team]) rolesByEntity.set(profile.entityId, profile.role);
  }
  return {
    source: {
      tenantId: 'demo-org',
      matchId: 'synthetic-derby-01',
      reducerRevision: projected.revisionCount,
      sourceHash: sha256({
        events: sha256(projected.acceptedEvents),
        tracking: sha256(projected.acceptedTracking),
      }),
      timeline,
      tracking: projected.acceptedTracking,
      events: projected.acceptedEvents,
      playerEntityIds: [
        ...new Set(
          projected.acceptedTracking.map((sample) => sample.entityId).filter((id) => id !== 'ball'),
        ),
      ].sort(),
      rolesByEntity,
      candidates,
      rightsPolicyAllowlist: ['synthetic-0bsd-demo-v1', 'demo-synthetic-policy-v1'],
      assetUrlPrefixes: ['https://assets.kyneloom.local/tenants/demo-org/'],
    },
  };
}

function compileGolden(
  source: CompilerSourceContext,
  basedOnOverride?: { readonly sourceHash?: string; readonly reducerRevision?: number },
): CompileResult {
  const corpus = buildCompileCorpus(source);
  const proposal =
    basedOnOverride === undefined
      ? corpus.golden
      : {
          ...corpus.golden,
          basedOn: { ...corpus.golden.basedOn, ...basedOnOverride },
        };
  return compileMomentProposal(proposal, source);
}

describe('compileMomentProposal — golden path', () => {
  it('compiles the deterministic golden proposal into a valid manifest draft', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The compiler's own contract self-check plus an independent re-parse.
    const reparsed = parseMomentManifest(result.manifest);
    expect(reparsed.ok).toBe(true);
    expect(result.manifest.status).toBe('draft');
    expect(result.manifest.approval).toBeNull();
    expect(result.manifest.schemaVersion).toBe('0.2.0');
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]!.kind).toBe('separation-delta');
  });

  it('is deterministic: identical inputs compile to identical manifests and hashes', () => {
    const { source } = buildSource();
    const a = compileGolden(source);
    const b = compileGolden(source);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalJsonStringify(a.manifest)).toBe(canonicalJsonStringify(b.manifest));
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
    // Deterministic across a JSON round-trip too (agent transport reality).
    const round = compileMomentProposal(
      JSON.parse(JSON.stringify(buildCompileCorpus(source).golden)),
      source,
    );
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.manifestHash).toBe(a.manifestHash);
  });

  it('computes the hash exactly as documented: sha256 over canonical approvalContentPayload', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = sha256(approvalContentPayload(result.manifest));
    expect(result.manifestHash).toBe(expected);
  });

  it('derives broadcast cues and recap from the same clock and evidence set', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const presentation = result.manifest.presentation;
    expect(presentation).toBeDefined();
    if (presentation === undefined) return;
    const [, endMs] = result.manifest.timeRangeMs;
    const windowMs = endMs - result.manifest.timeRangeMs[0];
    const evidenceIds = new Set(result.manifest.evidence.map((entry) => entry.id));
    for (const cue of presentation.broadcast) {
      // Manifest clock law: cue times are offsets from the moment start.
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeLessThanOrEqual(windowMs);
      for (const id of cue.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    }
    // The metric cue quotes the recomputed numbers; the caption cue carries
    // the hypothesis editorial text; the recap mirrors the manifest claims.
    expect(presentation.broadcast.some((cue) => cue.text.includes('SEPARATION'))).toBe(true);
    expect(presentation.recap.lines.map((line) => line.claimId)).toEqual(
      result.manifest.claims.map((claim) => claim.id),
    );
    const hypothesis = presentation.recap.lines.find((line) => line.status === 'hypothesis');
    expect(hypothesis?.inferenceDisclosure).toBeDefined();
  });

  it('TEXT LAW: verified claim sentences are compiler-generated from the deterministic facts', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calculated = result.manifest.claims.find((claim) => claim.status === 'calculated');
    expect(calculated).toBeDefined();
    // The recomputed truth (6.317 → 23.063, Δ 16.746) in the generated sentence.
    expect(calculated!.text).toContain('16.746');
    expect(calculated!.text).toContain('6.317');
    expect(calculated!.text).toContain('23.063');
    expect(calculated!.text).toContain('between 78:41 and 78:49');
    // Observed text names the actual cited event.
    const observed = result.manifest.claims.find((claim) => claim.status === 'observed');
    expect(observed).toBeDefined();
    expect(observed!.text).toContain('evt-0042');
    expect(observed!.text.toLowerCase()).toContain('pass completed');
    // Hypothesis editorial prose passes through, labeled.
    const hypothesis = result.manifest.claims.find((claim) => claim.status === 'hypothesis');
    expect(hypothesis?.inferenceDisclosure).toBeDefined();
  });

  it('keeps overlay evidence and metric references resolvable in the manifest', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const aliases = new Set(result.metrics.map((metric) => metric.alias));
    for (const overlay of result.manifest.scene.overlays) {
      if (overlay.metricRef !== undefined) expect(aliases.has(overlay.metricRef)).toBe(true);
    }
    // Derived-metric evidence cites the metric's REAL dependency frames —
    // the two window-endpoint frames (frame ids encode time, so defender and
    // striker at the same instant share one frame id).
    const separation = result.manifest.evidence.find((entry) => entry.kind === 'derived_metric');
    expect(separation).toBeDefined();
    expect(separation!.inputRefs).toEqual(['frame-47217', 'frame-47298']);
  });
});

describe('compileMomentProposal — the corpus acceptance matrix', () => {
  it('every well-formed corpus entry compiles; every defect rejects (with its named code)', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    for (const entry of corpus.entries) {
      const result = compileMomentProposal(entry.proposal, source);
      if (entry.expect === 'valid') {
        expect(result.ok, `entry ${entry.id} should compile`).toBe(true);
      } else {
        expect(result.ok, `entry ${entry.id} should be rejected`).toBe(false);
        if (!result.ok && entry.expectedCode !== undefined) {
          expect(
            result.errors.some((error) => error.code === entry.expectedCode),
            `entry ${entry.id} should report ${entry.expectedCode}; got ${result.errors
              .map((error) => error.code)
              .join(', ')}`,
          ).toBe(true);
        }
        if (!result.ok) {
          for (const error of result.errors) {
            expect(error.fieldPath.length).toBeGreaterThan(0);
            expect(error.message.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('the false distance claim dies with the recomputed value named (grand-prize demo)', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const entry = corpus.entries.find((candidate) => candidate.id === 'defect-false-distance');
    expect(entry).toBeDefined();
    const result = compileMomentProposal(entry!.proposal, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.errors.find((candidate) => candidate.code === 'unsupported_claim');
      expect(error).toBeDefined();
      expect(error!.fieldPath).toBe('claims[0].metricAssertion.assertedValue');
      expect(error!.message).toContain('14');
      expect(error!.message).toContain('23.063'); // the recomputed truth
    }
  });
});

describe('compileMomentProposal — source-correction invalidation', () => {
  it('a tracking correction changes the digest and makes the identical proposal stale', () => {
    const pristine = buildSource();
    const pristineCorpus = buildCompileCorpus(pristine.source);
    const raw = loadRaw();
    // A one-sample correction: away-03 nudged 0.5 m at the first frame of
    // the window. Digest changes → every previous compile is stale.
    const corrected = raw.tracking.map((sample) =>
      sample.entityId === 'away-03' && sample.sampleTimeMs === 4_721_700
        ? { ...sample, xM: sample.xM + 0.5 }
        : sample,
    );
    const correctedSource = buildSource({ ...raw, tracking: corrected });
    expect(correctedSource.source.sourceHash).not.toBe(pristine.source.sourceHash);

    // The proposal was derived against the PRISTINE digest — compiling it
    // against the corrected source must reject as stale.
    const result = compileMomentProposal(pristineCorpus.golden, correctedSource.source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'stale_revision')).toBe(true);
    }
  });

  it('a stale reducer revision is rejected with the current revision in the message', () => {
    const { source } = buildSource();
    const result = compileGolden(source, { reducerRevision: source.reducerRevision + 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.errors.find((candidate) => candidate.code === 'stale_revision');
      expect(error).toBeDefined();
      expect(error!.message).toContain(String(source.reducerRevision));
    }
  });

  it('low-confidence endpoint tracking withholds the metric — insufficient evidence, never an invented number', () => {
    const pristine = buildSource();
    const pristineCorpus = buildCompileCorpus(pristine.source);
    const raw = loadRaw();
    // Degraded source: both separation endpoints at the window start drop to
    // confidence 0.5 (below the shared 0.9 policy). The candidate registry
    // row (pristine detection, pinned) still exists — the real stale-compile
    // shape — and the proposal's basedOn is refreshed to the degraded digest
    // so ONLY the metric gate can stop it.
    const degraded = raw.tracking.map((sample) =>
      sample.sampleTimeMs === 4_721_700 &&
      (sample.entityId === 'away-03' || sample.entityId === 'home-09')
        ? { ...sample, confidence: 0.5 }
        : sample,
    );
    const degradedSource = buildSource({ ...raw, tracking: degraded }, { pinCandidatesFrom: raw });
    const proposal = {
      ...pristineCorpus.golden,
      basedOn: { ...pristineCorpus.golden.basedOn, sourceHash: degradedSource.source.sourceHash },
    };
    const result = compileMomentProposal(proposal, degradedSource.source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'insufficient_evidence')).toBe(true);
    }
  });

  it('missing endpoint tracking withholds the metric — no spatial geometry is invented', () => {
    const pristine = buildSource();
    const pristineCorpus = buildCompileCorpus(pristine.source);
    const raw = loadRaw();
    // Drop away-03's sample at the window end — the separation cannot
    // resolve its second endpoint, so nothing spatial may be compiled.
    const degraded = raw.tracking.filter(
      (sample) => !(sample.entityId === 'away-03' && sample.sampleTimeMs === 4_729_800),
    );
    const degradedSource = buildSource({ ...raw, tracking: degraded }, { pinCandidatesFrom: raw });
    const proposal = {
      ...pristineCorpus.golden,
      basedOn: { ...pristineCorpus.golden.basedOn, sourceHash: degradedSource.source.sourceHash },
    };
    const result = compileMomentProposal(proposal, degradedSource.source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'insufficient_evidence')).toBe(true);
      expect(
        result.errors.some((error) => /missing|endpoint|insufficient/i.test(error.message)),
      ).toBe(true);
    }
  });
});

describe('compileMomentProposal — fail-closed identity, rights and commands', () => {
  it('rejects a cross-tenant proposal', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const result = compileMomentProposal({ ...corpus.golden, tenantId: 'rival-org' }, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'cross_tenant_reference')).toBe(true);
    }
  });

  it('rejects a proposal for a match this source does not have', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const result = compileMomentProposal({ ...corpus.golden, matchId: 'some-other-match' }, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'missing_reference')).toBe(true);
    }
  });

  it('rejects a rights policy outside the tenant allowlist', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const result = compileMomentProposal(
      { ...corpus.golden, rightsPolicyRef: 'pirated-broadcast-v9' },
      source,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'rights_violation')).toBe(true);
    }
  });

  it('rejects declared inputs that do not match the computed dependencies', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const tampered = {
      ...corpus.golden,
      evidence: corpus.golden.evidence.map((entry) =>
        entry.id === 'ev-separation' ? { ...entry, inputRefs: ['frame-99999'] } : entry,
      ),
    };
    const result = compileMomentProposal(tampered, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (error) =>
            error.fieldPath === 'evidence[0].inputRefs' && error.code === 'missing_reference',
        ),
      ).toBe(true);
    }
  });
});

describe('compileMomentProposal — one identity covers all audience output (blocker B)', () => {
  it('changing only the recap headline changes the content identity', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const a = compileMomentProposal(corpus.golden, source);
    const b = compileMomentProposal(
      { ...corpus.golden, recapHeadline: 'A different true story' },
      source,
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.manifestHash).not.toBe(b.manifestHash);
    expect(b.manifest.presentation?.recap.headline).toBe('A different true story');
  });

  it('changing a visible caption timing changes the content identity', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const a = compileMomentProposal(corpus.golden, source);
    const caption = corpus.golden.overlays.find((overlay) => overlay.kind === 'caption');
    expect(caption).toBeDefined();
    const b = compileMomentProposal(
      {
        ...corpus.golden,
        overlays: corpus.golden.overlays.map((overlay) =>
          overlay.id === caption!.id ? { ...overlay, startMs: overlay.startMs + 500 } : overlay,
        ),
      },
      source,
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it('changing one camera keyframe changes the content identity', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const a = compileMomentProposal(corpus.golden, source);
    const b = compileMomentProposal(
      {
        ...corpus.golden,
        cameraTracks: corpus.golden.cameraTracks.map((track) => ({
          ...track,
          keyframes: track.keyframes.map((keyframe, index) =>
            index === 1 ? { ...keyframe, fovDeg: 41 } : keyframe,
          ),
        })),
      },
      source,
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it('the stored artifact reconstructs all outputs after JSON serialization, without the proposal', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The persisted artifact is the manifest alone; serialize → reparse →
    // the same hashed content, cues and recap come back.
    const persisted = JSON.parse(JSON.stringify(result.manifest)) as unknown;
    const reparsed = parseMomentManifest(persisted);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(canonicalJsonStringify(reparsed.data)).toBe(canonicalJsonStringify(result.manifest));
    expect(reparsed.data.presentation?.broadcast).toBeDefined();
    expect(reparsed.data.presentation?.recap.headline).toBe(
      'The run nobody passed to opened the goal',
    );
    expect(sha256(approvalContentPayload(reparsed.data))).toBe(result.manifestHash);
  });

  it('approvals remain null — the compiler cannot authorize publication', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.approval).toBeNull();
    expect(result.manifest.status).toBe('draft');
  });
});

describe('compileMomentProposal — the factual-text bypass is closed (blocker A)', () => {
  it('a calculated claim with false prose and no assertion never compiles (the review bypass)', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const bypass = {
      ...corpus.golden,
      claims: corpus.golden.claims.map((claim) =>
        claim.status === 'calculated'
          ? {
              ...claim,
              text: 'The defender was exactly 14 metres away.',
              metricAssertion: undefined,
            }
          : claim,
      ),
    };
    const result = compileMomentProposal(bypass, source);
    expect(result.ok).toBe(false);
  });

  it('a correct assertion cannot smuggle contradictory prose beside it', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const smuggler = {
      ...corpus.golden,
      claims: corpus.golden.claims.map((claim) =>
        claim.status === 'calculated'
          ? { ...claim, text: '…and the defender was exactly 14 metres away.' }
          : claim,
      ),
    };
    const result = compileMomentProposal(smuggler, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.fieldPath === 'claims[0].text')).toBe(true);
    }
  });

  it('an observed claim citing a derived metric is rejected — observations are source events', () => {
    const { source } = buildSource();
    const corpus = buildCompileCorpus(source);
    const mislabeled = {
      ...corpus.golden,
      claims: corpus.golden.claims.map((claim) =>
        claim.status === 'observed' ? { ...claim, evidenceIds: ['ev-separation'] } : claim,
      ),
    };
    const result = compileMomentProposal(mislabeled, source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === 'missing_reference')).toBe(true);
    }
  });

  it('every verified-claim sentence equals the deterministic formatter output — nothing else can appear', () => {
    const { source } = buildSource();
    const result = compileGolden(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calculated = result.manifest.claims.find((claim) => claim.status === 'calculated');
    expect(calculated!.text).toBe(metricFactSentence(result.metrics[0]!));
  });
});

describe('rescaleCameraTrackToWindow', () => {
  it('re-expresses moment offsets on an earlier scene window exactly once', () => {
    const track = {
      id: 'cam',
      mode: 'directed' as const,
      startMs: 0,
      endMs: 1000,
      keyframes: [
        { tMs: 0, position: [0, 0, 10] as [number, number, number] },
        { tMs: 1000, position: [1, 1, 10] as [number, number, number] },
      ],
    };
    const rescaled = rescaleCameraTrackToWindow(track, 4_721_700, 4_717_000);
    expect(rescaled.startMs).toBe(4700);
    expect(rescaled.endMs).toBe(5700);
    expect(rescaled.keyframes.map((keyframe) => keyframe.tMs)).toEqual([4700, 5700]);
  });
});
