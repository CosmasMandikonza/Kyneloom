import type { TrackingSample, MatchEvent } from '@kyneloom/contracts';
import type { Timeline } from '../reducer/timeline';
import {
  nearestOpponent,
  NEAREST_OPPONENT_VERSION,
  type NearestOpponentInput,
} from './metric-nearest';
import { laneOccupancy, LANE_OCCUPANCY_VERSION, type LaneOccupancyInput } from './metric-lane';
import {
  offBallMovement,
  OFF_BALL_MOVEMENT_VERSION,
  type OffBallMovementInput,
} from './metric-movement';
import { separationDelta, type SeparationDeltaInput } from './metric-separation-adapter';
import { SEPARATION_ALGORITHM_VERSION } from '../reducer/metric-separation';
import type { MetricResult } from './metric-result';

/**
 * KYN-12 — the bounded read-only metric tool for agents
 * (`get_metric`, docs/07).
 *
 * This module is the TYPE-CALLABLE SERVICE BOUNDARY a future Microsoft
 * Foundry agent will sit behind. It is deterministic, read-only and
 * fail-closed:
 *
 * - Only the four allowlisted metric kinds are dispatchable; anything else
 *   is a typed rejection (`unsupported-metric`).
 * - Entity ids must match the contracts grammar; time bounds must be finite
 *   and inside the source's tracked window.
 * - The response carries ONLY the MetricResult (units, provenance,
 *   dependencies, status) — never raw source dumps.
 * - The model on the far side can READ numbers; it can never SUPPLY one.
 *   `validateClaim` exists so an agent-proposed numerical claim can be
 *   checked against the tool's own recomputation — the deterministic
 *   verifier adjudicates (docs/07), not persuasion.
 * - Causal claims about spatial→event causation are structurally
 *   unsupported: no metric result contains a causal verdict, and the claim
 *   policy refuses them outright.
 */

export const METRIC_TOOL_VERSION = 'kyneloom-get-metric-v1';

/** Hard cap on corridor width an agent may request (metres). */
export const MAX_LANE_WIDTH_M = 20;
/** Hard cap on a movement window (milliseconds). */
export const MAX_WINDOW_MS = 120_000;
/** Hard cap on grid resolution an agent may request. */
export const MIN_SAMPLE_STEP_MS = 50;

export type MetricQuery =
  | {
      readonly kind: 'nearest-opponent';
      readonly entityId: string;
      readonly atMs: number;
      readonly defendersOnly?: boolean;
    }
  | {
      readonly kind: 'separation-delta';
      readonly defenderId: string;
      readonly strikerId: string;
      readonly fromMs: number;
      readonly toMs: number;
    }
  | {
      readonly kind: 'passing-lane-occupancy';
      readonly fromEntityId: string;
      readonly fromAtMs: number;
      readonly toEntityId: string;
      readonly toAtMs: number;
      readonly widthM: number;
    }
  | {
      readonly kind: 'off-ball-movement';
      readonly entityId: string;
      readonly fromMs: number;
      readonly toMs: number;
      readonly opponentEntityId?: string;
      readonly sampleStepMs?: number;
    };

export type MetricQueryRequest =
  | { readonly ok: true; readonly query: MetricQuery }
  | { readonly ok: false; readonly code: string; readonly detail: string };

const ENTITY_ID_PATTERN = /^(home|away)-\d{2}$/;

export interface MetricToolContext {
  readonly matchId: string;
  readonly reducerRevision: number;
  readonly timeline: Timeline;
  readonly tracking: readonly TrackingSample[];
  readonly events: readonly MatchEvent[];
  /** All player entity ids in the tracked corpus. */
  readonly playerEntityIds: readonly string[];
  /** Authoritative roster roles (entityId → role), when the source has them. */
  readonly rolesByEntity?: ReadonlyMap<string, string>;
}

/** Validate + normalize a raw (untrusted) query. Fail closed on anything unexpected. */
export function parseMetricQuery(raw: unknown): MetricQueryRequest {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'malformed-query', detail: 'query must be an object' };
  }
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const entityId = (value: unknown): value is string =>
    typeof value === 'string' && ENTITY_ID_PATTERN.test(value);

  switch (kind) {
    case 'nearest-opponent': {
      if (!entityId(record['entityId'])) {
        return { ok: false, code: 'invalid-entity', detail: 'entityId must match home-XX/away-XX' };
      }
      if (!finite(record['atMs'])) {
        return { ok: false, code: 'invalid-time', detail: 'atMs must be finite milliseconds' };
      }
      const defendersOnly = record['defendersOnly'];
      if (defendersOnly !== undefined && typeof defendersOnly !== 'boolean') {
        return { ok: false, code: 'invalid-argument', detail: 'defendersOnly must be boolean' };
      }
      return {
        ok: true,
        query: {
          kind: 'nearest-opponent',
          entityId: record['entityId'],
          atMs: record['atMs'],
          defendersOnly: defendersOnly === true ? true : undefined,
        },
      };
    }
    case 'separation-delta': {
      if (!entityId(record['defenderId']) || !entityId(record['strikerId'])) {
        return {
          ok: false,
          code: 'invalid-entity',
          detail: 'defenderId/strikerId must match home-XX/away-XX',
        };
      }
      if (!finite(record['fromMs']) || !finite(record['toMs'])) {
        return {
          ok: false,
          code: 'invalid-time',
          detail: 'fromMs/toMs must be finite milliseconds',
        };
      }
      if ((record['toMs'] as number) <= (record['fromMs'] as number)) {
        return { ok: false, code: 'invalid-window', detail: 'toMs must be after fromMs' };
      }
      if ((record['toMs'] as number) - (record['fromMs'] as number) > MAX_WINDOW_MS) {
        return {
          ok: false,
          code: 'window-too-large',
          detail: `window exceeds ${String(MAX_WINDOW_MS)} ms cap`,
        };
      }
      return {
        ok: true,
        query: {
          kind: 'separation-delta',
          defenderId: record['defenderId'],
          strikerId: record['strikerId'],
          fromMs: record['fromMs'],
          toMs: record['toMs'],
        },
      };
    }
    case 'passing-lane-occupancy': {
      if (!entityId(record['fromEntityId']) || !entityId(record['toEntityId'])) {
        return {
          ok: false,
          code: 'invalid-entity',
          detail: 'endpoints must match home-XX/away-XX',
        };
      }
      if (!finite(record['fromAtMs']) || !finite(record['toAtMs'])) {
        return {
          ok: false,
          code: 'invalid-time',
          detail: 'endpoint times must be finite milliseconds',
        };
      }
      if (
        !finite(record['widthM']) ||
        (record['widthM'] as number) <= 0 ||
        (record['widthM'] as number) > MAX_LANE_WIDTH_M
      ) {
        return {
          ok: false,
          code: 'invalid-argument',
          detail: `widthM must be in (0, ${String(MAX_LANE_WIDTH_M)}] metres`,
        };
      }
      return {
        ok: true,
        query: {
          kind: 'passing-lane-occupancy',
          fromEntityId: record['fromEntityId'],
          fromAtMs: record['fromAtMs'],
          toEntityId: record['toEntityId'],
          toAtMs: record['toAtMs'],
          widthM: record['widthM'],
        },
      };
    }
    case 'off-ball-movement': {
      if (!entityId(record['entityId'])) {
        return { ok: false, code: 'invalid-entity', detail: 'entityId must match home-XX/away-XX' };
      }
      if (!finite(record['fromMs']) || !finite(record['toMs'])) {
        return {
          ok: false,
          code: 'invalid-time',
          detail: 'fromMs/toMs must be finite milliseconds',
        };
      }
      if ((record['toMs'] as number) <= (record['fromMs'] as number)) {
        return { ok: false, code: 'invalid-window', detail: 'toMs must be after fromMs' };
      }
      if ((record['toMs'] as number) - (record['fromMs'] as number) > MAX_WINDOW_MS) {
        return {
          ok: false,
          code: 'window-too-large',
          detail: `window exceeds ${String(MAX_WINDOW_MS)} ms cap`,
        };
      }
      const opponentEntityId = record['opponentEntityId'];
      if (opponentEntityId !== undefined && !entityId(opponentEntityId)) {
        return {
          ok: false,
          code: 'invalid-entity',
          detail: 'opponentEntityId must match home-XX/away-XX',
        };
      }
      const sampleStepMs = record['sampleStepMs'];
      if (
        sampleStepMs !== undefined &&
        (!finite(sampleStepMs) || (sampleStepMs as number) < MIN_SAMPLE_STEP_MS)
      ) {
        return {
          ok: false,
          code: 'invalid-argument',
          detail: `sampleStepMs must be ≥ ${String(MIN_SAMPLE_STEP_MS)} ms`,
        };
      }
      return {
        ok: true,
        query: {
          kind: 'off-ball-movement',
          entityId: record['entityId'],
          fromMs: record['fromMs'],
          toMs: record['toMs'],
          opponentEntityId: opponentEntityId as string | undefined,
          sampleStepMs: sampleStepMs as number | undefined,
        },
      };
    }
    default:
      return {
        ok: false,
        code: 'unsupported-metric',
        detail: `kind must be one of nearest-opponent | separation-delta | passing-lane-occupancy | off-ball-movement`,
      };
  }
}

export type MetricToolResult =
  | { readonly ok: true; readonly toolVersion: string; readonly result: MetricResult<unknown> }
  | {
      readonly ok: false;
      readonly toolVersion: string;
      readonly code: string;
      readonly detail: string;
    };

/** Execute a VALIDATED query against the resolved source context. */
export function executeMetricQuery(
  context: MetricToolContext,
  query: MetricQuery,
): MetricToolResult {
  const [minTime, maxTime] = [context.timeline.minTimeMs, context.timeline.maxTimeMs];
  const inWindow = (t: number): boolean => t >= minTime && t <= maxTime;
  const entityProblem = (id: string): string =>
    context.playerEntityIds.includes(id) ? '' : `entity ${id} is not tracked by this source`;

  switch (query.kind) {
    case 'nearest-opponent': {
      const problem = entityProblem(query.entityId);
      if (problem !== '')
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'unknown-entity',
          detail: problem,
        };
      if (!inWindow(query.atMs)) {
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'outside-tracked-window',
          detail: `atMs ${String(query.atMs)} outside tracked ${String(minTime)}..${String(maxTime)}`,
        };
      }
      const input: NearestOpponentInput = {
        matchId: context.matchId,
        entityId: query.entityId,
        atMs: query.atMs,
        candidateEntityIds: context.playerEntityIds,
        rolesByEntity: context.rolesByEntity,
        defendersOnly: query.defendersOnly,
      };
      return {
        ok: true,
        toolVersion: METRIC_TOOL_VERSION,
        result: nearestOpponent(
          context.timeline,
          context.tracking,
          context.reducerRevision,
          input,
        ) as MetricResult<unknown>,
      };
    }
    case 'separation-delta': {
      for (const id of [query.defenderId, query.strikerId]) {
        const problem = entityProblem(id);
        if (problem !== '')
          return {
            ok: false,
            toolVersion: METRIC_TOOL_VERSION,
            code: 'unknown-entity',
            detail: problem,
          };
      }
      if (!inWindow(query.fromMs) || !inWindow(query.toMs)) {
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'outside-tracked-window',
          detail: 'window extends beyond tracked coverage',
        };
      }
      const input: SeparationDeltaInput = { matchId: context.matchId, ...query };
      return {
        ok: true,
        toolVersion: METRIC_TOOL_VERSION,
        result: separationDelta(
          context.timeline,
          context.tracking,
          context.reducerRevision,
          input,
        ) as MetricResult<unknown>,
      };
    }
    case 'passing-lane-occupancy': {
      for (const id of [query.fromEntityId, query.toEntityId]) {
        const problem = entityProblem(id);
        if (problem !== '')
          return {
            ok: false,
            toolVersion: METRIC_TOOL_VERSION,
            code: 'unknown-entity',
            detail: problem,
          };
      }
      if (!inWindow(query.fromAtMs) || !inWindow(query.toAtMs)) {
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'outside-tracked-window',
          detail: 'endpoint times outside tracked coverage',
        };
      }
      const input: LaneOccupancyInput = {
        matchId: context.matchId,
        from: { entityId: query.fromEntityId, atMs: query.fromAtMs },
        to: { entityId: query.toEntityId, atMs: query.toAtMs },
        widthM: query.widthM,
        candidateEntityIds: context.playerEntityIds,
      };
      return {
        ok: true,
        toolVersion: METRIC_TOOL_VERSION,
        result: laneOccupancy(
          context.timeline,
          context.tracking,
          context.reducerRevision,
          input,
        ) as MetricResult<unknown>,
      };
    }
    case 'off-ball-movement': {
      const problem = entityProblem(query.entityId);
      if (problem !== '')
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'unknown-entity',
          detail: problem,
        };
      if (query.opponentEntityId !== undefined) {
        const opponentProblem = entityProblem(query.opponentEntityId);
        if (opponentProblem !== '')
          return {
            ok: false,
            toolVersion: METRIC_TOOL_VERSION,
            code: 'unknown-entity',
            detail: opponentProblem,
          };
      }
      if (!inWindow(query.fromMs) || !inWindow(query.toMs)) {
        return {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'outside-tracked-window',
          detail: 'window extends beyond tracked coverage',
        };
      }
      const input: OffBallMovementInput = {
        matchId: context.matchId,
        entityId: query.entityId,
        fromMs: query.fromMs,
        toMs: query.toMs,
        opponentEntityId: query.opponentEntityId,
        sampleStepMs: query.sampleStepMs,
        possessionEvents: context.events
          .filter((event) => event.actorId !== null)
          .map((event) => ({
            kind: event.kind,
            actorId: event.actorId as string,
            occurredAtMs: event.occurredAtMs,
            validityMs: 10_000,
          })),
      };
      return {
        ok: true,
        toolVersion: METRIC_TOOL_VERSION,
        result: offBallMovement(
          context.timeline,
          context.tracking,
          context.reducerRevision,
          input,
        ) as MetricResult<unknown>,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic claim policy (docs/07 validate_claims, scoped to metrics).
// ---------------------------------------------------------------------------

export type ClaimVerdict =
  | {
      readonly verdict: 'supported';
      readonly metricId: string;
      readonly algorithmVersion: string;
      readonly matchedValue: unknown;
    }
  | { readonly verdict: 'hypothesis_only'; readonly detail: string }
  | { readonly verdict: 'unsupported'; readonly detail: string };

export interface ClaimInput {
  /**
   * Causal objective claims (movement CAUSED an outcome) are structurally
   * unsupported by this library.
   */
  readonly kind: 'metric-value' | 'causal-objective';
  /** For metric-value: the asserted value must equal the tool's own output. */
  readonly metricId?: string;
  readonly assertedValue?: unknown;
  readonly causalStatement?: string;
}

export function validateClaim(
  claim: ClaimInput,
  computed: ReadonlyMap<string, MetricResult<unknown>>,
): ClaimVerdict {
  if (claim.kind === 'causal-objective') {
    return {
      verdict: 'unsupported',
      detail: `Causal objective claim '${claim.causalStatement ?? ''}' cannot be verified: no deterministic metric in kyneloom-get-metric-v1 establishes intent or causation. Permitted interpretation: hypothesis/editorial language with explicit disclosure.`,
    };
  }
  const metricId = claim.metricId ?? '';
  const result = computed.get(metricId);
  if (result === undefined) {
    return { verdict: 'unsupported', detail: `no computed metric result for ${metricId}` };
  }
  if (result.status === 'insufficient-evidence') {
    return {
      verdict: 'unsupported',
      detail: `metric ${metricId} is insufficient-evidence (${result.failure.code}); nothing may be asserted`,
    };
  }
  const asserted = JSON.stringify(claim.assertedValue ?? null);
  const actual = JSON.stringify(result.value);
  if (asserted !== actual) {
    return {
      verdict: 'unsupported',
      detail: `asserted value ${asserted} ≠ recomputed ${actual} for ${metricId}; the deterministic recomputation is authoritative`,
    };
  }
  return {
    verdict: 'supported',
    metricId,
    algorithmVersion: result.provenance.algorithmVersion,
    matchedValue: result.value,
  };
}

/** The allowlist the boundary advertises (metric kinds + versions). */
export const SUPPORTED_METRICS: readonly { kind: string; algorithmVersion: string }[] = [
  { kind: 'nearest-opponent', algorithmVersion: NEAREST_OPPONENT_VERSION },
  { kind: 'separation-delta', algorithmVersion: SEPARATION_ALGORITHM_VERSION },
  { kind: 'passing-lane-occupancy', algorithmVersion: LANE_OCCUPANCY_VERSION },
  { kind: 'off-ball-movement', algorithmVersion: OFF_BALL_MOVEMENT_VERSION },
];
