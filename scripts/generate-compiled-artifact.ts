/**
 * KYN-16 — regenerate the pinned compiled-manifest artifact
 * (`tests/fixtures/compiled/invisible-assist-directed-v1.json`).
 *
 * Runs the REAL pipeline over the committed golden fixture: reducer →
 * deterministic candidate detection → deterministic proposal corpus →
 * compiler. The committed artifact pins the exact manifest and content hash
 * the corpus must keep producing; tests/moment-compiler-golden.test.ts
 * refuses to let either drift silently.
 *
 * Run from the repository root: `pnpm tsx scripts/generate-compiled-artifact.ts`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJsonStringify, type MatchEvent, type TrackingSample } from '@kyneloom/contracts';
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

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../tests/fixtures/generated/synthetic-derby-01',
);
const OUT_PATH = path.resolve(
  import.meta.dirname,
  '../tests/fixtures/compiled/invisible-assist-directed-v1.json',
);

const events = JSON.parse(
  await import('node:fs').then((fs) =>
    fs.readFileSync(path.join(FIXTURE_DIR, 'events.json'), 'utf-8'),
  ),
) as MatchEvent[];
const tracking = (
  await import('node:fs').then((fs) =>
    fs.readFileSync(path.join(FIXTURE_DIR, 'tracking.jsonl'), 'utf-8'),
  )
)
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as TrackingSample);

const projected = projectMatch({ matchId: 'synthetic-derby-01', events, tracking });
const timeline = createTimeline(projected.acceptedTracking);
const sha = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
const rolesByEntity = new Map<string, string>();
for (const team of ['home', 'away'] as const) {
  for (const profile of ROSTERS[team]) rolesByEntity.set(profile.entityId, profile.role);
}

const source: CompilerSourceContext = {
  tenantId: 'demo-org',
  matchId: 'synthetic-derby-01',
  reducerRevision: projected.revisionCount,
  sourceHash: sha({
    events: sha(projected.acceptedEvents),
    tracking: sha(projected.acceptedTracking),
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

const corpus = buildCompileCorpus(source);
const result = compileMomentProposal(corpus.golden, source);
if (!result.ok) {
  console.error('golden corpus proposal failed to compile:', result.errors);
  process.exit(1);
}

const artifact = {
  schemaVersion: 'kyneloom-compiled-artifact-v1',
  note: 'Pinned output of the deterministic KYN-16 compiler over the committed golden fixture. Regenerate with pnpm tsx scripts/generate-compiled-artifact.ts. Any fixture or compiler change that alters this document changes the manifest hash by construction.',
  source: {
    matchId: source.matchId,
    reducerRevision: source.reducerRevision,
    sourceHash: source.sourceHash,
    candidateId: corpus.candidate.candidateId,
  },
  manifestHash: result.manifestHash,
  inputFingerprint: result.inputFingerprint,
  manifest: result.manifest,
};

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
console.log(`manifestHash ${result.manifestHash}`);
