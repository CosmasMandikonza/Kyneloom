/**
 * KYN-04 replay CLI: `pnpm replay:golden`
 *
 * Loads the COMMITTED golden fixture from tests/fixtures/generated, projects
 * the authoritative match, queries the golden checkpoint, computes the
 * separation metric and demonstrates a score-impacting correction — real
 * code, real data, no mocks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJsonStringify } from '@kyneloom/contracts';
import {
  computeSeparation,
  fnv1aHex,
  lateCorrection,
  projectMatch,
  verifySeparationEvidence,
} from '@kyneloom/match-core';

function loadGolden(): { events: unknown[]; tracking: unknown[]; matchId: string } {
  const dir = path.resolve('tests', 'fixtures', 'generated', 'synthetic-derby-01');
  const events = JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf-8')) as unknown[];
  const tracking = readFileSync(path.join(dir, 'tracking.jsonl'), 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const metadata = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf-8')) as {
    matchId: string;
  };
  return { events, tracking, matchId: metadata.matchId };
}

function main(): void {
  const golden = loadGolden();
  const match = projectMatch({
    matchId: golden.matchId,
    events: golden.events,
    tracking: golden.tracking,
  });

  console.log(`Kyneloom authoritative replay — ${golden.matchId}`);
  console.log(
    `  accepted events: ${match.acceptedEvents.length}  tracking samples: ${match.acceptedTracking.length}`,
  );
  console.log(
    `  duplicates collapsed: ${match.duplicateCount}  quarantined: ${match.quarantine.length}`,
  );

  const checkpoint = 4722100;
  const state = match.matchStateAt(checkpoint);
  console.log(`\n[checkpoint ${checkpoint} ms] (revision ${state.reducerRevision})`);
  console.log(`  period: ${state.period}  score: ${state.score.home}-${state.score.away}`);
  console.log(`  players with positions: ${state.players.length}`);
  console.log(
    `  ball: ${state.ball.position.kind}${state.ball.position.kind === 'positioned' ? ` (${state.ball.position.xM}, ${state.ball.position.yM}, z ${state.ball.position.zM})` : ''}`,
  );
  console.log(`  ball possessor: ${state.ball.possessorEntityId ?? '(none within 1.5 m)'}`);
  console.log(`  last accepted event: ${state.lastAcceptedEventId ?? '(none)'}`);
  console.log(`  state fingerprint: ${fnv1aHex(canonicalJsonStringify(state))}`);

  const separation = computeSeparation(match.acceptedTracking, {
    matchId: golden.matchId,
    defenderId: 'away-03',
    strikerId: 'home-09',
    fromMs: 4720500,
    toMs: 4724000,
  });
  if (separation.ok) {
    const e = separation.evidence;
    console.log(`\n[separation metric ${e.algorithmVersion}]`);
    console.log(`  ${e.defenderId} ↔ ${e.strikerId} over [${e.fromMs}, ${e.toMs}] ms`);
    console.log(
      `  ${e.separationBeforeM} m → ${e.separationAfterM} m  (Δ ${e.deltaM > 0 ? '+' : ''}${e.deltaM} m)`,
    );
    console.log(`  source frames: ${e.dependsOn.sourceFrameIds.join(', ')}`);
    console.log(
      `  verified against current tracking: ${verifySeparationEvidence(e, match.acceptedTracking)}`,
    );
  }

  const corrected = lateCorrection(golden.events as never, { asNoGoal: true });
  const correctedMatch = projectMatch({
    matchId: golden.matchId,
    events: corrected.events,
    tracking: golden.tracking,
  });
  console.log('\n[score-impacting correction: golden goal rescinded as offside]');
  console.log(
    `  before: ${match.matchStateAt(4728300).score.home}-${match.matchStateAt(4728300).score.away}  after: ${correctedMatch.matchStateAt(4728300).score.home}-${correctedMatch.matchStateAt(4728300).score.away}`,
  );
  console.log(
    `  rescinding envelope: ${correctedMatch.acceptedEvents.find((e) => e.kind === 'offside_called')?.eventId} → correctionOf ${correctedMatch.acceptedEvents.find((e) => e.kind === 'offside_called')?.correctionOf}`,
  );
  console.log(
    `  original goal retained in history: ${correctedMatch.eventHistory().some((e) => e.kind === 'goal' && e.eventId === 'evt-0010')}`,
  );
  console.log(
    `  separation evidence unaffected by event-only correction: ${separation.ok ? verifySeparationEvidence(separation.evidence, correctedMatch.acceptedTracking) : 'n/a'}`,
  );
  console.log(
    `\n  full-time (5,400,000 ms) ball position: ${match.matchStateAt(5_400_000).ball.position.kind} (explicitly no stale pose)`,
  );
}

const invokedScript = process.argv[1]?.replaceAll('\\', '/');
if (invokedScript != null && invokedScript.endsWith('scripts/replay-golden.ts')) {
  main();
}

export { loadGolden, main as runReplay };
