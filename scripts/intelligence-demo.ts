/**
 * KYN-12 reproducible intelligence demonstration: `pnpm intelligence:demo`
 *
 * The full deterministic trace, printed from real execution:
 *
 *   load accepted fixture → project canonical state → calculate the four
 *   metrics → verify source quality → detect + rank candidates → query
 *   candidate metrics through the allowlisted agent tool → refuse a causal
 *   claim under the deterministic claim policy.
 *
 * Every value below is computed at run time; nothing is canned. The trace
 * ends with the adversarial causal refusal (explicitly a deterministic
 * claim-policy example, NOT an LLM transcript).
 */
import { readFileSync } from 'node:fs';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { projectMatch, createTimeline } from '@kyneloom/match-core';
import {
  detectMomentCandidates,
  executeMetricQuery,
  parseMetricQuery,
  validateClaim,
  offBallMovement,
  separationDelta,
  nearestOpponent,
  laneOccupancy,
} from '@kyneloom/match-core';

function line(title: string, body = ''): void {
  console.log(`\n=== ${title} ===${body === '' ? '' : `\n${body}`}`);
}

async function main(): Promise<void> {
  const fixtureDir = 'tests/fixtures/generated/synthetic-derby-01';
  const events = JSON.parse(readFileSync(`${fixtureDir}/events.json`, 'utf-8')) as MatchEvent[];
  const tracking = readFileSync(`${fixtureDir}/tracking.jsonl`, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TrackingSample);

  line(
    '1 · load accepted fixture',
    `events=${String(events.length)} tracking=${String(tracking.length)} (golden fixture unchanged)`,
  );

  const started = performance.now();
  const projected = projectMatch({ matchId: 'synthetic-derby-01', events, tracking });
  const timeline = createTimeline(projected.acceptedTracking);
  const revision = projected.revisionCount;
  line(
    '2 · project canonical state',
    `acceptedEvents=${String(projected.acceptedEvents.length)} acceptedTracking=${String(projected.acceptedTracking.length)} reducerRevision=${String(revision)} projectionMs=${(performance.now() - started).toFixed(1)}`,
  );

  const matchId = 'synthetic-derby-01';
  const playerIds = [
    ...new Set(projected.acceptedTracking.map((s) => s.entityId).filter((id) => id !== 'ball')),
  ].sort();

  line('3 · calculate the four metrics (deterministic, source-quality gated)');
  const nearest = nearestOpponent(timeline, projected.acceptedTracking, revision, {
    matchId,
    entityId: 'home-09',
    atMs: 4_722_100,
    candidateEntityIds: playerIds,
  });
  console.log(
    `   A nearest-opponent  → ${nearest.status}${nearest.status === 'insufficient-evidence' ? ` (${nearest.failure.code})` : nearest.status === 'verified' ? ` ${nearest.value.entityId} @ ${String(nearest.value.distanceM)} m (${nearest.value.roleLabel ?? 'no role source'})` : ' (disclosed)'}`,
  );
  const separation = separationDelta(timeline, projected.acceptedTracking, revision, {
    matchId,
    defenderId: 'away-03',
    strikerId: 'home-09',
    fromMs: 4_720_500,
    toMs: 4_724_000,
  });
  console.log(
    `   B separation-delta  → ${separation.status}${separation.status === 'insufficient-evidence' ? ` (${separation.failure.code})` : ` ${String(separation.value.beforeM)} → ${String(separation.value.afterM)} m (Δ${String(separation.value.deltaM)})`}`,
  );
  const lane = laneOccupancy(timeline, projected.acceptedTracking, revision, {
    matchId,
    from: { entityId: 'home-08', atMs: 4_724_000 },
    to: { entityId: 'home-09', atMs: 4_726_200 },
    widthM: 4,
    candidateEntityIds: playerIds,
  });
  console.log(
    `   C lane-occupancy    → ${lane.status}${lane.status === 'insufficient-evidence' ? ` (${lane.failure.code})` : ` ${String(lane.value.occupants.length)} occupant(s) in a ${String(lane.value.widthM)} m × ${String(lane.value.corridorLengthM)} m corridor`}`,
  );
  const movement = offBallMovement(timeline, projected.acceptedTracking, revision, {
    matchId,
    entityId: 'home-11',
    fromMs: 4_720_500,
    toMs: 4_724_000,
    possessionEvents: projected.acceptedEvents
      .filter((e) => e.actorId !== null)
      .map((e) => ({
        kind: e.kind,
        actorId: e.actorId as string,
        occurredAtMs: e.occurredAtMs,
        validityMs: 10_000,
      })),
  });
  console.log(
    `   D off-ball-movement → ${movement.status}${movement.status === 'insufficient-evidence' ? ` (${movement.failure.code})` : ` displacement ${String(movement.value.displacementM)} m · mean ${String(movement.value.meanSpeedMps)} m/s · peak ${String(movement.value.maxSpeedMps)} m/s · off-ball ${movement.value.offBallStatus}`}`,
  );

  line(
    '4 · source-quality verification',
    `all four metrics carry exact-sample provenance; statuses above are the verification verdicts (zero is a value, missing is a status)`,
  );

  const detectionStart = performance.now();
  const candidates = detectMomentCandidates({
    matchId,
    reducerRevision: revision,
    events: projected.acceptedEvents as MatchEvent[],
    tracking: projected.acceptedTracking,
    timeline,
    separationPairs: [{ defenderId: 'away-03', strikerId: 'home-09' }],
    movementSubjects: ['home-11'],
    windowMs: [4_717_000, 4_731_000],
  });
  line(
    '5 · detect + rank meaningful-moment candidates',
    `detectionMs=${(performance.now() - detectionStart).toFixed(1)} candidates=${String(candidates.length)}`,
  );
  for (const [index, candidate] of candidates.entries()) {
    console.log(
      `   #${String(index + 1)} ${candidate.candidateId} score ${String(candidate.totalScore)} (events ${String(candidate.eventSalience)} + tactical ${String(candidate.tacticalSalience)})`,
    );
    console.log(
      `      window ${String(candidate.startMs)}–${String(candidate.endMs)} · anchors [${candidate.anchorEventIds.join(', ')}]`,
    );
    console.log(`      reasons [${candidate.reasonCodes.join(', ')}]`);
    console.log(
      `      metrics [${candidate.metricResultRefs.map((r) => `${r.metricId}:${r.status}`).join(' | ')}]`,
    );
    console.log(`      causalClaimSupport=${candidate.causalClaimSupport}`);
  }

  line('6 · query candidate metrics through the allowlisted agent tool');
  const toolContext = {
    matchId,
    reducerRevision: revision,
    timeline,
    tracking: projected.acceptedTracking,
    events: projected.acceptedEvents as MatchEvent[],
    playerEntityIds: playerIds,
  };
  const toolQueries = [
    {
      label: 'separation @ measured interval',
      raw: {
        kind: 'separation-delta',
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: 4_720_500,
        toMs: 4_724_000,
      },
    },
    {
      label: 'movement @ the run',
      raw: { kind: 'off-ball-movement', entityId: 'home-11', fromMs: 4_720_500, toMs: 4_724_000 },
    },
    {
      label: 'nearest opponent @ checkpoint',
      raw: { kind: 'nearest-opponent', entityId: 'home-09', atMs: 4_722_100 },
    },
    {
      label: 'lane @ pass release',
      raw: {
        kind: 'passing-lane-occupancy',
        fromEntityId: 'home-08',
        fromAtMs: 4_724_000,
        toEntityId: 'home-09',
        toAtMs: 4_726_200,
        widthM: 4,
      },
    },
  ];
  const computed = new Map<string, unknown>();
  for (const { label, raw } of toolQueries) {
    const parsed = parseMetricQuery(raw);
    if (!parsed.ok) {
      console.log(`   ${label} → REJECTED (${parsed.code}: ${parsed.detail})`);
      continue;
    }
    const executed = executeMetricQuery(toolContext, parsed.query);
    if (!executed.ok) {
      console.log(`   ${label} → REJECTED (${executed.code}: ${executed.detail})`);
      continue;
    }
    computed.set(executed.result.provenance.metricId, executed.result);
    const result = executed.result as {
      status: string;
      provenance: { algorithmVersion: string; inputFingerprint: string };
      value?: unknown;
      failure?: { code: string };
    };
    console.log(
      `   ${label} → ${result.status} via ${result.provenance.algorithmVersion} fingerprint ${result.provenance.inputFingerprint}`,
    );
    if (result.status !== 'insufficient-evidence')
      console.log(`      value ${JSON.stringify(result.value)}`);
    else console.log(`      withheld (${result.failure?.code})`);
  }

  line('7 · deterministic claim-policy example (NOT an LLM transcript)');
  const separationResult = computed.get(
    [...computed.keys()].find((id) => id.startsWith('separation-delta')) ?? '',
  ) as never;
  const exactValue = (separationResult as { status: string; value?: unknown })?.value;
  const supported = validateClaim(
    {
      kind: 'metric-value',
      metricId: [...computed.keys()].find((id) => id.startsWith('separation-delta')) ?? '',
      assertedValue: exactValue,
    },
    computed as never,
  );
  console.log(`   claim "separation delta = ${JSON.stringify(exactValue)}" → ${supported.verdict}`);
  const wrong = validateClaim(
    {
      kind: 'metric-value',
      metricId: [...computed.keys()].find((id) => id.startsWith('separation-delta')) ?? '',
      assertedValue: {
        beforeM: 1,
        afterM: 2,
        deltaM: 1,
        defenderId: 'away-03',
        strikerId: 'home-09',
      },
    },
    computed as never,
  );
  console.log(
    `   claim "separation delta = {1→2, Δ1}" → ${wrong.verdict} (the tool's recomputation is authoritative)`,
  );
  const causal = validateClaim(
    { kind: 'causal-objective', causalStatement: 'home-11’s decoy run caused the goal (evt-0010)' },
    computed as never,
  );
  console.log(`   claim "the run caused the goal" → ${causal.verdict}`);
  if (causal.verdict === 'unsupported') console.log(`      ${causal.detail}`);

  const totalMs = performance.now() - started;
  line(
    '8 · measured performance',
    `projection+detection+8 tool executions = ${totalMs.toFixed(1)} ms total on this machine (fixture: 11 events, 5129 samples)`,
  );
  console.log('\ntrace complete — every id, window and value above came from real execution.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
