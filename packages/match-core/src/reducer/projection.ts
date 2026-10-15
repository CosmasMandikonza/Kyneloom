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
 * Authoritative match projection (KYN-04). `projectMatch` ingests a stream
 * once and returns an immutable view: the fold over accepted events is
 * deterministic (canonical order), checkpoints are addressed by reducer
 * revision (= number of accepted events consumed), and `matchStateAt` is a
 * pure function of (accepted input, timeMs, revision).
 *
 * Event-derived facts (clock context, period, score, last accepted event,
 * source metadata) come from the fold; positions come from the timeline
 * sampler over accepted tracking. Presentation state (camera, lenses) never
 * lives here — camera changes cannot touch match truth.
 */

export interface ProjectedMatch {
  readonly matchId: string;
  readonly acceptedEvents: readonly MatchEvent[];
  readonly acceptedTracking: readonly TrackingSample[];
  readonly quarantine: readonly QuarantinedItem[];
  readonly duplicateCount: number;
  readonly timeline: Timeline;
  /** Number of immutable checkpoints (= accepted events). */
  readonly revisionCount: number;
  /** Full accepted event history (all revisions) stays inspectable — nothing is mutated. */
  eventHistory(): readonly MatchEvent[];
  /** State projected at `timeMs` as of checkpoint `revision` (latest when omitted). */
  matchStateAt(timeMs: number, revision?: number): MatchState;
  /** The state after consuming every accepted event, projected at the last event time. is wrong— use maxTime. */
  latestState(atMs?: number): MatchState;
}

export interface ProjectOptions extends StreamIngestOptions, TimelineOptions {
  /** Max distance for a player to be considered the ball possessor. */
  readonly possessionRadiusM?: number;
}

export function projectMatch(
  input: {
    readonly matchId: string;
    readonly events: readonly unknown[];
    readonly tracking: readonly unknown[];
  },
  options: ProjectOptions = {},
): ProjectedMatch {
  const possessionRadiusM = options.possessionRadiusM ?? 1.5;
  const ingested = ingestMatchStream(input, options);
  const timeline = createTimeline(ingested.acceptedTracking, options);
  const events = ingested.acceptedEvents;

  const clampRevision = (revision: number | undefined): number => {
    if (revision === undefined) return events.length;
    if (!Number.isInteger(revision) || revision < 0 || revision > events.length) {
      throw new RangeError(
        `revision must be an integer in [0, ${String(events.length)}], got ${String(revision)}`,
      );
    }
    return revision;
  };

  const matchStateAt = (timeMs: number, revision?: number): MatchState => {
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new RangeError(`timeMs must be a non-negative finite number, got ${String(timeMs)}`);
    }
    const upTo = clampRevision(revision);
    const applicable = events.slice(0, upTo).filter((e) => e.occurredAtMs <= timeMs);

    // ---- event-derived facts ----
    const score = { home: 0, away: 0 };
    for (const event of applicable) {
      if (event.kind === 'goal' || event.kind === 'own_goal') {
        // Own-goal semantics (docs/05): teamId is the BENEFITING team.
        const beneficiary = event.teamId ?? event.attributes?.['benefiting_team'];
        if (beneficiary === 'home') score.home += 1;
        else if (beneficiary === 'away') score.away += 1;
      }
    }

    let period: MatchPeriod = 'pre_match';
    for (const event of applicable) {
      const attrPeriod = event.attributes?.['period'];
      if (event.kind === 'period_start' && typeof attrPeriod === 'string') {
        period = attrPeriod === 'first_half' ? 'first_half' : mapPeriod(attrPeriod);
      } else if (event.kind === 'period_end') {
        if (attrPeriod === 'first_half') period = 'half_time';
        else if (attrPeriod === 'full_time') period = 'post_match';
      }
    }

    const lastAccepted = applicable.length > 0 ? applicable[applicable.length - 1]! : null;
    const providerId = lastAccepted?.providerId ?? 'kyneloom-simulator';
    let latestSourceRevision = 0;
    let acceptedCount = 0;
    for (const event of applicable) {
      acceptedCount += 1;
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
    let ballSample = frame.entities.find((e) => e.entityId === 'ball') ?? null;
    for (const entity of frame.entities) {
      if (entity.entityId === 'ball') {
        ballSample = entity;
        continue;
      }
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
    if (ballSample !== null) {
      // Possession: the nearest player within the radius — a measured fact,
      // not an inference; no candidate => explicitly no possessor.
      let possessor: string | null = null;
      let bestDistance = possessionRadiusM;
      for (const player of players) {
        const d = Math.hypot(player.xM - ballSample!.xM, player.yM - ballSample!.yM);
        if (d <= bestDistance) {
          bestDistance = d;
          possessor = player.entityId;
        }
      }
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
        acceptedEventCount: acceptedCount,
        latestSourceRevision,
      },
    };
  };

  return {
    matchId: input.matchId,
    acceptedEvents: events,
    acceptedTracking: ingested.acceptedTracking,
    quarantine: ingested.quarantine,
    duplicateCount: ingested.duplicateCount,
    timeline,
    revisionCount: events.length,
    eventHistory: () => ingested.allEventRevisions.slice(),
    matchStateAt,
    latestState: (atMs?: number) => matchStateAt(atMs ?? timeline.maxTimeMs),
  };
}

function mapPeriod(raw: string): MatchPeriod {
  switch (raw) {
    case 'first_half':
      return 'first_half';
    case 'second_half':
      return 'second_half';
    default:
      return 'first_half';
  }
}
