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
  type CompilerSourceContext,
} from '@kyneloom/moment-compiler';

/**
 * KYN-16 golden artifact contract: the committed compiled manifest
 * (tests/fixtures/compiled/invisible-assist-directed-v1.json) is the pinned
 * output of the REAL pipeline over the committed fixture. It must stay
 * byte-identical — same manifest, same content hash — until either the
 * fixture or the compiler intentionally changes, and the artifact pins the
 * hash Studio/publishing will bind approvals to.
 */

const GENERATED_DIR = path.resolve(import.meta.dirname, 'fixtures/generated/synthetic-derby-01');
const ARTIFACT_PATH = path.resolve(
  import.meta.dirname,
  'fixtures/compiled/invisible-assist-directed-v1.json',
);

interface PinnedArtifact {
  readonly schemaVersion: string;
  readonly source: {
    readonly matchId: string;
    readonly reducerRevision: number;
    readonly sourceHash: string;
    readonly candidateId: string;
  };
  readonly manifestHash: string;
  readonly inputFingerprint: string;
  readonly manifest: Record<string, unknown>;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

function buildSource(): CompilerSourceContext {
  const events = JSON.parse(
    readFileSync(path.join(GENERATED_DIR, 'events.json'), 'utf-8'),
  ) as MatchEvent[];
  const tracking = readFileSync(path.join(GENERATED_DIR, 'tracking.jsonl'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrackingSample);
  const projected = projectMatch({ matchId: 'synthetic-derby-01', events, tracking });
  const timeline = createTimeline(projected.acceptedTracking);
  const rolesByEntity = new Map<string, string>();
  for (const team of ['home', 'away'] as const) {
    for (const profile of ROSTERS[team]) rolesByEntity.set(profile.entityId, profile.role);
  }
  return {
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
    candidates: detectMomentCandidates({
      matchId: 'synthetic-derby-01',
      reducerRevision: projected.revisionCount,
      events: projected.acceptedEvents,
      tracking: projected.acceptedTracking,
      timeline,
      separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
      movementSubjects: ['home-11'],
      windowMs: [4_717_000, 4_731_000],
    }),
    rightsPolicyAllowlist: ['synthetic-0bsd-demo-v1', 'demo-synthetic-policy-v1'],
    assetUrlPrefixes: ['https://assets.kyneloom.local/tenants/demo-org/'],
  };
}

describe('KYN-16 pinned compiled-manifest artifact', () => {
  it('reproduces the committed manifest and hash from the committed fixture', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')) as PinnedArtifact;
    const source = buildSource();
    expect(artifact.source.sourceHash).toBe(source.sourceHash);
    expect(artifact.source.reducerRevision).toBe(source.reducerRevision);

    const corpus = buildCompileCorpus(source);
    expect(corpus.candidate.candidateId).toBe(artifact.source.candidateId);

    const result = compileMomentProposal(corpus.golden, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canonicalJsonStringify(result.manifest)).toBe(canonicalJsonStringify(artifact.manifest));
    expect(result.manifestHash).toBe(artifact.manifestHash);
    expect(result.inputFingerprint).toBe(artifact.inputFingerprint);
  });

  it('the pinned hash is exactly sha256(canonical approvalContentPayload(manifest))', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')) as PinnedArtifact;
    expect(sha256(approvalContentPayload(artifact.manifest as never))).toBe(artifact.manifestHash);
  });

  it('pinned broadcast cues sit inside the moment window on the manifest clock', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')) as PinnedArtifact;
    const source = buildSource();
    const corpus = buildCompileCorpus(source);
    const result = compileMomentProposal(corpus.golden, source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [startMs, endMs] = artifact.manifest['timeRangeMs'] as [number, number];
    expect(startMs).toBe(4_721_700);
    expect(endMs).toBe(4_729_800);
    const cues = result.manifest.presentation?.broadcast ?? [];
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      // Manifest clock law: offsets from the moment start.
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeLessThanOrEqual(endMs - startMs);
    }
    // The stored artifact pins the SAME cues (identity covers the output).
    const pinnedCues = (
      (artifact.manifest as { presentation?: { broadcast?: { id: string }[] } }).presentation ?? {}
    ).broadcast;
    expect(pinnedCues?.map((cue) => cue.id)).toEqual(cues.map((cue) => cue.id));
  });

  it('the pinned artifact round-trips: reparse reproduces the hashed content without the proposal', () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')) as PinnedArtifact;
    const reparsed = parseMomentManifest(JSON.parse(JSON.stringify(artifact.manifest)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(canonicalJsonStringify(reparsed.data)).toBe(
      canonicalJsonStringify(artifact.manifest as never),
    );
    expect(sha256(approvalContentPayload(reparsed.data))).toBe(artifact.manifestHash);
    expect(reparsed.data.presentation?.recap.headline).toBe(
      'The run nobody passed to opened the goal',
    );
  });
});
