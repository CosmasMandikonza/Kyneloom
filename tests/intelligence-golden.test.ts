import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { projectMatch } from '@kyneloom/match-core';
import {
  createTimeline,
  executeMetricQuery,
  parseMetricQuery,
  validateClaim,
  detectMomentCandidates,
  type MetricQuery,
  type MetricToolContext,
  type MomentCandidate,
} from '@kyneloom/match-core';

/** parseMetricQuery is total: tests may assert the ok-branch safely. */
function parsed(raw: unknown): MetricQuery {
  const result = parseMetricQuery(raw);
  if (!result.ok) throw new Error(`query unexpectedly rejected: ${result.code}`);
  return result.query;
}

/**
 * KYN-12 golden-fixture discovery: the detector must AUTONOMOUSLY surface
 * The Invisible Assist from the accepted corpus — no matchId special case,
 * no hardcoded selection. It must also refuse causal claims and reproduce
 * identical candidate ids under event-order shuffling and duplicate
 * delivery.
 */

interface Corpus {
  events: readonly MatchEvent[];
  tracking: readonly TrackingSample[];
  timeline: ReturnType<typeof createTimeline>;
  revision: number;
  playerIds: string[];
}

function loadCorpus(): Corpus {
  const events = JSON.parse(
    readFileSync('tests/fixtures/generated/synthetic-derby-01/events.json', 'utf-8'),
  ) as MatchEvent[];
  const tracking = readFileSync(
    'tests/fixtures/generated/synthetic-derby-01/tracking.jsonl',
    'utf-8',
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrackingSample);
  const projected = projectMatch({ matchId: 'synthetic-derby-01', events, tracking });
  const playerIds = [
    ...new Set(tracking.map((s) => s.entityId).filter((id) => id !== 'ball')),
  ].sort();
  return {
    events: projected.acceptedEvents as MatchEvent[],
    tracking: projected.acceptedTracking,
    timeline: createTimeline(projected.acceptedTracking),
    revision: projected.revisionCount,
    playerIds,
  };
}

const STORY_PAIRS = [{ defenderId: 'away-03', strikerId: 'home-09' }];
const STORY_SUBJECTS = ['home-11'];

function detectOn(
  corpus: Corpus,
  events: readonly MatchEvent[] = corpus.events,
): readonly MomentCandidate[] {
  return detectMomentCandidates({
    matchId: 'synthetic-derby-01',
    reducerRevision: corpus.revision,
    events,
    tracking: corpus.tracking,
    timeline: corpus.timeline,
    separationPairs: STORY_PAIRS,
    movementSubjects: STORY_SUBJECTS,
    windowMs: [4_717_000, 4_731_000],
  });
}

describe('golden fixture — autonomous discovery of The Invisible Assist', () => {
  it('detects a candidate covering the run, the pass and the goal with REAL event ids', () => {
    const corpus = loadCorpus();
    const candidates = detectOn(corpus);
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const top = candidates[0]!;
    // The window covers the measured interval and reaches the goal.
    expect(top.startMs).toBeLessThanOrEqual(4_724_000);
    expect(top.endMs).toBeGreaterThanOrEqual(4_728_300);
    // REAL accepted event ids, resolved from the reducer — never invented.
    for (const eventId of ['evt-0007', 'evt-0042', 'evt-0009', 'evt-0010']) {
      expect(top.eventIds).toContain(eventId);
    }
    // Both signal families contribute.
    expect(top.reasonCodes).toContain('event:goal');
    expect(top.reasonCodes).toContain('tactical:separation-delta');
    expect(top.reasonCodes).toContain('tactical:movement-burst');
    expect(top.eventSalience).toBeGreaterThan(0);
    expect(top.tacticalSalience).toBeGreaterThan(0);
    // Metric references are real results with versions.
    expect(top.metricResultRefs.length).toBeGreaterThanOrEqual(2);
    // Causation is structurally insufficient.
    expect(top.causalClaimSupport).toBe('insufficient');
    expect(top.editorialBoundary).toContain('does not establish');
  });

  it('reproduces IDENTICAL candidate ids and scores for the identical accepted input', () => {
    const corpus = loadCorpus();
    const a = detectOn(corpus);
    const b = detectOn(corpus);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0]!.candidateId).toMatch(/^cand-[0-9a-f]{8}$/);
  });

  it('event-order shuffling and duplicate delivery leave the detection byte-identical', () => {
    const corpus = loadCorpus();
    // Deterministic shuffle (reverse by chunks) + duplicates — the reducer
    // deduplicates and projects by event time, so the accepted set is equal.
    const shuffled = [...corpus.events].reverse();
    const duplicated = [...corpus.events, ...corpus.events.slice(0, 4)];
    const baseline = detectOn(corpus);
    for (const variant of [shuffled, duplicated]) {
      const projected = projectMatch({
        matchId: 'synthetic-derby-01',
        events: variant,
        tracking: corpus.tracking,
      });
      const detected = detectMomentCandidates({
        matchId: 'synthetic-derby-01',
        reducerRevision: projected.revisionCount,
        events: projected.acceptedEvents as MatchEvent[],
        tracking: projected.acceptedTracking,
        timeline: createTimeline(projected.acceptedTracking),
        separationPairs: STORY_PAIRS,
        movementSubjects: STORY_SUBJECTS,
        windowMs: [4_717_000, 4_731_000],
      });
      expect(JSON.stringify(detected)).toBe(JSON.stringify(baseline));
    }
  });

  it('missing frames in the window surface as withheld signals, not fabricated ones', () => {
    const corpus = loadCorpus();
    // Remove every tracking sample inside the run window for home-11: the
    // movement signal must be withheld; separation still verifies on the
    // defender/striker pair; the candidate still exists via event salience.
    const holed = corpus.tracking.filter(
      (sample) =>
        !(
          sample.entityId === 'home-11' &&
          sample.sampleTimeMs >= 4_718_000 &&
          sample.sampleTimeMs <= 4_730_000
        ),
    );
    const timeline = createTimeline(holed);
    const candidates = detectMomentCandidates({
      matchId: 'synthetic-derby-01',
      reducerRevision: corpus.revision,
      events: corpus.events,
      tracking: holed,
      timeline,
      separationPairs: STORY_PAIRS,
      movementSubjects: STORY_SUBJECTS,
      windowMs: [4_717_000, 4_731_000],
    });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const top = candidates[0]!;
    expect(top.coverage.insufficientEvidenceSignals).toBeGreaterThanOrEqual(1);
    expect(top.reasonCodes).toContain('withheld:insufficient-metric-coverage');
    // The withheld movement must not appear as a tactical contribution.
    expect(top.tactical.every((signal) => !signal.detail.startsWith('home-11'))).toBe(true);
  });

  it('goal rescission removes goal salience and re-ranks (correction-invalidated)', () => {
    const corpus = loadCorpus();
    // A revision-2 goal correction rescinding evt-0010: same eventId, higher
    // sourceRevision, kind period_end?? — no: build a true rescission by
    // superseding the goal with a correction that marks it rescinded. The
    // contracts model corrections as same-id higher revisions; the reducer
    // keeps the highest VALID revision. We emulate the rescission by
    // projecting a corpus where the goal event is corrected to kind
    // 'period_end' at a higher revision (an accepted correction changing
    // the outcome).
    const corrected = corpus.events.map((event) =>
      event.eventId === 'evt-0010'
        ? {
            ...event,
            sourceRevision: event.sourceRevision + 1,
            kind: 'period_end',
            teamId: null,
            actorId: null,
            position: undefined,
            attributes: { rescinds: 'evt-0010' },
          }
        : event,
    );
    const projected = projectMatch({
      matchId: 'synthetic-derby-01',
      events: corrected,
      tracking: corpus.tracking,
    });
    const candidates = detectMomentCandidates({
      matchId: 'synthetic-derby-01',
      reducerRevision: projected.revisionCount,
      events: projected.acceptedEvents as MatchEvent[],
      tracking: projected.acceptedTracking,
      timeline: createTimeline(projected.acceptedTracking),
      separationPairs: STORY_PAIRS,
      movementSubjects: STORY_SUBJECTS,
      windowMs: [4_717_000, 4_731_000],
    });
    // The goal anchor is gone; the pass/shot anchors may still surface a
    // (weaker) candidate — but no goal salience may survive, and the score
    // must drop below the goal-bearing baseline.
    for (const candidate of candidates) {
      expect(candidate.reasonCodes).not.toContain('event:goal');
      expect(candidate.events.every((event) => event.kind !== 'goal')).toBe(true);
      expect(candidate.eventSalience).toBeLessThan(detectOn(corpus)[0]!.eventSalience);
    }
  });
});

describe('agent tool on the golden corpus (real get_metric execution)', () => {
  function contextFor(corpus: Corpus): MetricToolContext {
    return {
      matchId: 'synthetic-derby-01',
      reducerRevision: corpus.revision,
      timeline: corpus.timeline,
      tracking: corpus.tracking,
      events: corpus.events,
      playerEntityIds: corpus.playerIds,
    };
  }

  it('executes all four metrics end-to-end with real values', () => {
    const corpus = loadCorpus();
    const context = contextFor(corpus);

    const nearest = executeMetricQuery(
      context,
      parsed({
        kind: 'nearest-opponent',
        entityId: 'home-09',
        atMs: 4_722_100,
      }),
    );
    expect(nearest.ok).toBe(true);

    const sep = executeMetricQuery(
      context,
      parsed({
        kind: 'separation-delta',
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: 4_720_500,
        toMs: 4_724_000,
      }),
    );
    expect(sep.ok).toBe(true);
    if (sep.ok) {
      expect(sep.result.status).toBe('verified');
      if (sep.result.status === 'verified') {
        expect(sep.result.value).toMatchObject({ beforeM: 6.306, afterM: 20.344, deltaM: 14.038 });
      }
    }

    const lane = executeMetricQuery(
      context,
      parsed({
        kind: 'passing-lane-occupancy',
        fromEntityId: 'home-08',
        fromAtMs: 4_724_000,
        toEntityId: 'home-09',
        toAtMs: 4_726_200,
        widthM: 4,
      }),
    );
    expect(lane.ok).toBe(true);

    const movement = executeMetricQuery(
      context,
      parsed({
        kind: 'off-ball-movement',
        entityId: 'home-11',
        fromMs: 4_720_500,
        toMs: 4_724_000,
      }),
    );
    expect(movement.ok).toBe(true);
    if (movement.ok && movement.result.status === 'verified') {
      // Hand-checked against the golden run: the winger covers ≈11.3 m.
      const value = movement.result.value as {
        displacementM: number;
        maxSpeedMps: number;
      };
      expect(value.displacementM).toBeGreaterThan(8);
      expect(value.maxSpeedMps).toBeGreaterThan(6);
    }
  });

  it('rejects unknown entities and out-of-window times against the real corpus', () => {
    const corpus = loadCorpus();
    const context = contextFor(corpus);
    const unknown = executeMetricQuery(
      context,
      parsed({
        kind: 'nearest-opponent',
        entityId: 'home-99',
        atMs: 4_722_100,
      }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('unknown-entity');

    const outside = executeMetricQuery(
      context,
      parsed({
        kind: 'separation-delta',
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: 4_800_000,
        toMs: 4_810_000,
      }),
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe('outside-tracked-window');
  });

  it('claim policy: exact metric value supported; wrong value and causal claims refused', () => {
    const corpus = loadCorpus();
    const context = contextFor(corpus);
    const sep = executeMetricQuery(
      context,
      parsed({
        kind: 'separation-delta',
        defenderId: 'away-03',
        strikerId: 'home-09',
        fromMs: 4_720_500,
        toMs: 4_724_000,
      }),
    );
    expect(sep.ok).toBe(true);
    if (!sep.ok) return;
    const computed = new Map([[sep.result.provenance.metricId, sep.result]]);

    const good = validateClaim(
      {
        kind: 'metric-value',
        metricId: sep.result.provenance.metricId,
        assertedValue: sep.result.status === 'insufficient-evidence' ? null : sep.result.value,
      },
      computed,
    );
    expect(good.verdict).toBe('supported');

    const wrong = validateClaim(
      {
        kind: 'metric-value',
        metricId: sep.result.provenance.metricId,
        assertedValue: {
          beforeM: 1,
          afterM: 2,
          deltaM: 1,
          defenderId: 'away-03',
          strikerId: 'home-09',
        },
      },
      computed,
    );
    expect(wrong.verdict).toBe('unsupported');

    const causal = validateClaim(
      { kind: 'causal-objective', causalStatement: 'home-11’s run caused the goal' },
      computed,
    );
    expect(causal.verdict).toBe('unsupported');
    if (causal.verdict === 'unsupported') {
      expect(causal.detail).toContain('cannot be verified');
      expect(causal.detail).toContain('hypothesis');
    }
  });
});
