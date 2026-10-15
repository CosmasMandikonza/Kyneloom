import {
  entityTeam,
  type MatchEvent,
  type MatchState,
  type MatchPeriod,
  type TrackingSample,
} from '@kyneloom/contracts';
import { ingestMatchStream, type QuarantinedItem, type StreamIngestOptions } from './ingest';
import { createTimeline, type Timeline, type TimelineOptions } from './timeline';

/**
 * Authoritative match projection (KYN-04).
 *
 * AS-OF REVISION CHECKPOINTS: the reducer's revision timeline is the ingest
 * application sequence — every VALID envelope (base events, then corrections
 * ordered by sourceRevision). `revision N` = the state after the first N
 * envelopes were applied, so genuinely historical snapshots exist: the score
 * BEFORE a goal rescission (revision that includes the goal, not yet the
 * correction) and AFTER it are both addressable, and the superseded goal
 * stays inspectable in `eventHistory()`.
 *
 * POSSESSION is a source-verified fact only: it is populated exclusively
 * when an accepted event explicitly identifies the possessor (kickoff actor,
 * pass_completed target, shot_attempted actor), and that identification
 * EXPIRES after `possessionValidityMs` (default 10 s) or at the next
 * possession-changing event (pass in flight, goal, period boundary).
 * Spatial proximity is NEVER used — closeness is not proof of possession,
 * and nearest-player estimation stays a presentation-layer concern outside
 * the canonical contract.
 *
 * PERIOD: first_half is derived from an accepted kickoff (a kickoff with no
 * preceding period_start starts the first half — the committed fixture has
 * no explicit first-half period_start); explicit period events still govern
 * half_time/second_half/post_match.
 */

export interface ProjectedMatch {
  readonly matchId: string;
  /** Final effective events (highest VALID revision per identity). */
  readonly acceptedEvents: readonly MatchEvent[];
  readonly acceptedTracking: readonly TrackingSample[];
  readonly quarantine: readonly QuarantinedItem[];
  readonly duplicateCount: number;
  readonly timeline: Timeline;
  /** Number of as-of checkpoints (= VALID envelopes in application order). */
  readonly revisionCount: number;
  /** Full valid envelope history in application order — inspectable, never mutated. */
  eventHistory(): readonly MatchEvent[];
  /**
   * State projected at `timeMs` as of checkpoint `revision` (the state after
   * the first `revision` envelopes of the application sequence were applied;
   * latest when omitted). Historical pre-correction snapshots included.
   */
  matchStateAt(timeMs: number, revision?: number): MatchState;
  /** Latest-checkpoint state projected at `atMs` (default: last sample time). */
  latestState(atMs?: number): MatchState;
}

export interface ProjectOptions extends StreamIngestOptions, TimelineOptions {
  /** How long an event-identified possession stays asserted without a new
   *  source identification; beyond this the possessor is explicitly null. */
  readonly possessionValidityMs?: number;
}

interface PossessionAssertion {
  readonly entityId: string;
  readonly sinceMs: number;
}

export function projectMatch(
  input: {
    readonly matchId: string;
    readonly events: readonly unknown[];
    readonly tracking: readonly unknown[];
  },
  options: ProjectOptions = {},
): ProjectedMatch {
  const possessionValidityMs = options.possessionValidityMs ?? 10_000;
  const ingested = ingestMatchStream(input, options);
  const timeline = createTimeline(ingested.acceptedTracking, options);
  const sequence = ingested.allEventRevisions;
  const finalEffective = ingested.acceptedEvents;

  const clampRevision = (revision: number | undefined): number => {
    if (revision === undefined) return sequence.length;
    if (!Number.isInteger(revision) || revision < 0 || revision > sequence.length) {
      throw new RangeError(
        `revision must be an integer in [0, ${String(sequence.length)}], got ${String(revision)}`,
      );
    }
    return revision;
  };

  const matchStateAt = (timeMs: number, revision?: number): MatchState => {
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new RangeError(`timeMs must be a non-negative finite number, got ${String(timeMs)}`);
    }
    const upTo = clampRevision(revision);
    const applied = sequence.slice(0, upTo);

    // Effective per identity at this time: the highest applied revision of
    // each identity whose occurredAtMs <= timeMs (a correction does not
    // retroactively apply before its own event time).
    const bestPerIdentity = new Map<string, MatchEvent>();
    for (const event of applied) {
      if (event.occurredAtMs > timeMs) continue;
      const key = `${event.providerId}|${event.eventId}`;
      const current = bestPerIdentity.get(key);
      if (current === undefined || event.sourceRevision > current.sourceRevision) {
        bestPerIdentity.set(key, event);
      }
    }
    const effective = [...bestPerIdentity.values()].sort(
      (a, b) =>
        a.occurredAtMs - b.occurredAtMs ||
        (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    );

    // ---- event-derived facts ----
    const score = { home: 0, away: 0 };
    for (const event of effective) {
      if (event.kind === 'goal' || event.kind === 'own_goal') {
        // Own-goal semantics (docs/05): teamId is the BENEFITING team.
        const beneficiary = event.teamId ?? event.attributes?.['benefiting_team'];
        if (beneficiary === 'home') score.home += 1;
        else if (beneficiary === 'away') score.away += 1;
      }
    }

    let period: MatchPeriod = 'pre_match';
    let possession: PossessionAssertion | null = null;
    for (const event of effective) {
      const attrPeriod = event.attributes?.['period'];
      if (event.kind === 'period_start' && typeof attrPeriod === 'string') {
        period = attrPeriod === 'second_half' ? 'second_half' : 'first_half';
        possession = null; // period boundary: previous identification void
      } else if (event.kind === 'period_end') {
        if (attrPeriod === 'first_half') period = 'half_time';
        else if (attrPeriod === 'full_time') period = 'post_match';
        possession = null;
      } else if (event.kind === 'kickoff') {
        // A kickoff with no explicit period_start starts the first half.
        if (period === 'pre_match') period = 'first_half';
        possession =
          event.actorId !== null ? { entityId: event.actorId, sinceMs: event.occurredAtMs } : null;
      } else if (event.kind === 'pass_attempted') {
        possession = null; // ball in flight: nobody possesses it
      } else if (event.kind === 'pass_completed') {
        const target = event.attributes?.['target_player_id'];
        possession =
          typeof target === 'string' ? { entityId: target, sinceMs: event.occurredAtMs } : null;
      } else if (event.kind === 'shot_attempted') {
        possession =
          event.actorId !== null ? { entityId: event.actorId, sinceMs: event.occurredAtMs } : null;
      } else if (event.kind === 'goal' || event.kind === 'own_goal') {
        possession = null; // ball dead
      }
    }

    const lastAccepted = effective.length > 0 ? effective[effective.length - 1]! : null;
    const providerId = lastAccepted?.providerId ?? 'kyneloom-simulator';
    let latestSourceRevision = 0;
    for (const event of effective) {
      latestSourceRevision = Math.max(latestSourceRevision, event.sourceRevision);
    }

    // ---- tracking-derived positions (through the shared timeline) ----
    const frame = timeline.sampleAt(timeMs);
    const players: MatchState['players'] = [];
    let ball: MatchState['ball'] = {
      entityId: 'ball',
      position: { kind: 'unavailable', reason: 'no_tracking_source' },
      possessorEntityId: null,
    };
    const ballSample = frame.entities.find((e) => e.entityId === 'ball') ?? null;
    for (const entity of frame.entities) {
      if (entity.entityId === 'ball') continue;
      const team = entityTeam(entity.entityId);
      if (team === null) continue; // only home-/away- players exist in this model
      players.push({
        entityId: entity.entityId,
        teamId: team,
        xM: entity.xM,
        yM: entity.yM,
        zM: entity.zM,
        status: 'on_pitch',
        positionOrigin: entity.origin,
        confidence: 1,
      });
    }
    // Possession: ONLY a fresh, explicit source identification — never
    // proximity, never asserted on an unavailable ball.
    let possessor: string | null = null;
    if (
      ballSample !== null &&
      possession !== null &&
      timeMs - possession.sinceMs <= possessionValidityMs
    ) {
      const identified = possession.entityId;
      if (players.some((p) => p.entityId === identified)) {
        possessor = identified;
      }
    }
    if (ballSample !== null) {
      ball = {
        entityId: 'ball',
        position: {
          kind: 'positioned',
          xM: ballSample.xM,
          yM: ballSample.yM,
          zM: ballSample.zM,
          positionOrigin: ballSample.origin,
          confidence: 1,
        },
        possessorEntityId: possessor,
      };
    }

    return {
      schemaVersion: '1.0',
      matchId: input.matchId,
      reducerRevision: upTo,
      matchTimeMs: timeMs,
      period,
      score,
      ball,
      players,
      lastAcceptedEventId: lastAccepted?.eventId ?? null,
      source: {
        providerId,
        acceptedEventCount: effective.length,
        latestSourceRevision,
      },
    };
  };

  return {
    matchId: input.matchId,
    acceptedEvents: finalEffective,
    acceptedTracking: ingested.acceptedTracking,
    quarantine: ingested.quarantine,
    duplicateCount: ingested.duplicateCount,
    timeline,
    revisionCount: sequence.length,
    eventHistory: () => sequence.slice(),
    matchStateAt,
    latestState: (atMs?: number) => matchStateAt(atMs ?? timeline.maxTimeMs),
  };
}
