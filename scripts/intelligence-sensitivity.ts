/**
 * KYN-12 threshold sensitivity evaluation: `pnpm intelligence:sensitivity`
 *
 * Real-execution perturbation table for the candidate scorer's documented
 * thresholds (docs/21): every row below is a genuine `detectMomentCandidates`
 * run over the UNMODIFIED golden corpus with ONE threshold changed. The
 * purpose is honesty about ranking behavior — where the golden moment
 * survives, where it drops out, and how sharp each boundary is — not a
 * claim of optimality. Deterministic: same corpus + same override → same
 * row, on any machine (only wall-clock timings vary).
 */
import { readFileSync } from 'node:fs';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { projectMatch, createTimeline } from '@kyneloom/match-core';
import {
  CANDIDATE_THRESHOLDS,
  detectMomentCandidates,
  type DetectionThresholds,
  type MomentCandidate,
} from '@kyneloom/match-core';

const STORY_PAIRS = [{ defenderId: 'away-03', strikerId: 'home-09' }];
const STORY_SUBJECTS = ['home-11'];
const WINDOW: readonly [number, number] = [4_717_000, 4_731_000];

interface Corpus {
  readonly events: readonly MatchEvent[];
  readonly tracking: readonly TrackingSample[];
  readonly timeline: ReturnType<typeof createTimeline>;
  readonly revision: number;
}

function loadCorpus(): Corpus {
  const fixtureDir = 'tests/fixtures/generated/synthetic-derby-01';
  const events = JSON.parse(readFileSync(`${fixtureDir}/events.json`, 'utf-8')) as MatchEvent[];
  const tracking = readFileSync(`${fixtureDir}/tracking.jsonl`, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TrackingSample);
  const projected = projectMatch({ matchId: 'synthetic-derby-01', events, tracking });
  return {
    events: projected.acceptedEvents,
    tracking: projected.acceptedTracking,
    timeline: createTimeline(projected.acceptedTracking),
    revision: projected.revisionCount,
  };
}

function detect(
  corpus: Corpus,
  overrides?: Partial<DetectionThresholds>,
): readonly MomentCandidate[] {
  return detectMomentCandidates({
    matchId: 'synthetic-derby-01',
    reducerRevision: corpus.revision,
    events: corpus.events,
    tracking: corpus.tracking,
    timeline: corpus.timeline,
    separationPairs: STORY_PAIRS,
    movementSubjects: STORY_SUBJECTS,
    windowMs: WINDOW,
    thresholds: overrides,
  });
}

function summarize(candidates: readonly MomentCandidate[]): string {
  if (candidates.length === 0) return 'no candidates surfaced';
  const top = candidates[0]!;
  const families = top.reasonCodes
    .filter((code) => code.startsWith('tactical:') || code.startsWith('event:'))
    .join('+');
  return (
    `${String(candidates.length)} candidate(s) · top ${top.candidateId} score ${String(top.totalScore)}` +
    ` (events ${String(top.eventSalience)} + tactical ${String(top.tacticalSalience)}) · ${families}`
  );
}

function row(label: string, candidates: readonly MomentCandidate[]): void {
  console.log(`${label.padEnd(34)}| ${summarize(candidates)}`);
}

function main(): void {
  const corpus = loadCorpus();
  console.log('KYN-12 candidate-scoring threshold sensitivity — real execution');
  console.log(
    `corpus: synthetic-derby-01 (golden, unmodified) · reducerRevision ${String(corpus.revision)} · defaults ${JSON.stringify(CANDIDATE_THRESHOLDS)}`,
  );

  console.log('\n== baseline (defaults) ==');
  row('default', detect(corpus));
  const baseline = detect(corpus);
  const goldenId = baseline[0]?.candidateId ?? '(none)';
  console.log(`golden candidate id: ${goldenId}`);

  console.log('\n== minimumTotalScore (score floor) ==');
  for (const value of [0, 10, 20, 25, 30, 50, 80, 120, 140, 141, 150, 200]) {
    row(`floor = ${String(value)}`, detect(corpus, { minimumTotalScore: value }));
  }

  console.log('\n== movementBurstMps (sustained-speed bar) ==');
  for (const value of [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0]) {
    const candidates = detect(corpus, { movementBurstMps: value });
    const keepsBurst = candidates[0]?.reasonCodes.includes('tactical:movement-burst') ?? false;
    row(`burst bar = ${value.toFixed(1)} m/s`, candidates);
    console.log(`${''.padEnd(34)}|   ↳ movement-burst signal: ${keepsBurst ? 'present' : 'LOST'}`);
  }

  console.log('\n== separationDeltaM (separation signal bar) ==');
  for (const value of [2, 3, 4, 5, 6, 8, 10, 14, 15]) {
    const candidates = detect(corpus, { separationDeltaM: value });
    const keeps = candidates[0]?.reasonCodes.includes('tactical:separation-delta') ?? false;
    row(`separation bar = ${String(value)} m`, candidates);
    console.log(`${''.padEnd(34)}|   ↳ separation-delta signal: ${keeps ? 'present' : 'LOST'}`);
  }

  console.log('\n== proximityDeltaM (proximity bar) ==');
  for (const value of [2, 3, 4, 5, 6]) {
    const candidates = detect(corpus, { proximityDeltaM: value });
    const keeps = candidates[0]?.reasonCodes.includes('tactical:proximity-gain') ?? false;
    row(`proximity bar = ${String(value)} m`, candidates);
    console.log(`${''.padEnd(34)}|   ↳ proximity-gain signal: ${keeps ? 'present' : 'LOST'}`);
  }

  console.log('\n== tacticalLookbackMs (window look-back) ==');
  for (const value of [1500, 2500, 3500, 4500, 6000, 8000]) {
    const candidates = detect(corpus, { tacticalLookbackMs: value });
    const top = candidates[0];
    row(`lookback = ${String(value)} ms`, candidates);
    if (top !== undefined) {
      console.log(
        `${''.padEnd(34)}|   ↳ top window ${String(top.startMs)}–${String(top.endMs)} (${String(top.endMs - top.startMs)} ms)`,
      );
    }
  }

  console.log(
    '\nAll rows recomputed from the unmodified accepted corpus; overrides never mutate defaults.',
  );
}

main();
