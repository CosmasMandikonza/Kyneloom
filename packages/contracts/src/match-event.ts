import { z } from 'zod';
import { confidence, EVENT_ORIGINS } from './data-origin';
import { type ParseResult, toContractValidationErrors } from './errors';
import { kebabId, teamId, utcTimestamp } from './ids';
import { vec2M } from './spatial';
import { EVENT_SCHEMA_VERSION, majorMinorVersion, unsupportedVersionError } from './versioning';

/**
 * Canonical incoming match event (docs/05 "canonical incoming event").
 *
 * TIME CONVENTION: `occurredAtMs` is **absolute match-relative milliseconds**
 * — monotonically increasing from first kickoff (t = 0), never reset between
 * periods. `ingestedAt` is an ISO-8601 UTC wall-clock instant used for
 * arrival ordering only. Camera/overlay times inside a MomentManifest are a
 * different axis: offsets from the start of the moment window.
 *
 * Unknown-field policy: strict. Unrecognized keys are rejected so producers
 * cannot smuggle uncontracted data through the envelope.
 */

export const EVENT_KINDS = [
  'period_start',
  'period_end',
  'kickoff',
  'pass_attempted',
  'pass_completed',
  'pass_intercepted',
  'pass_off_target',
  'shot_attempted',
  'shot_saved',
  'shot_off_target',
  'shot_blocked',
  'goal',
  'own_goal',
  'dribble',
  'tackle_won',
  'tackle_lost',
  'foul_committed',
  'free_kick_awarded',
  'penalty_awarded',
  'corner_awarded',
  'offside_called',
  'throw_in_awarded',
  'goal_kick_awarded',
  'substitution',
  'injury_stoppage',
  'var_review',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const eventKind = z.enum(EVENT_KINDS);

/**
 * Open extension point: kind-specific attributes are primitive-valued only.
 * Structured payloads belong in new versioned contract fields, never here.
 */
export const eventAttributes = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const eventProvenance = z.strictObject({
  origin: z.enum(EVENT_ORIGINS),
  generatorVersion: z.string().min(1).optional(),
  licenseRef: z.string().min(1).optional(),
  confidence: confidence,
});

export type EventProvenance = z.infer<typeof eventProvenance>;

export const matchEventSchema = z.strictObject({
  schemaVersion: majorMinorVersion,
  eventId: kebabId,
  providerId: kebabId,
  tenantId: kebabId,
  matchId: kebabId,
  fixtureSeed: z.number().int().nonnegative().optional(),
  sourceRevision: z.number().int().positive(),
  kind: eventKind,
  occurredAtMs: z.number().int().nonnegative(),
  ingestedAt: utcTimestamp,
  sequence: z.number().int().nonnegative(),
  actorId: kebabId.nullable(),
  teamId: teamId.nullable(),
  position: vec2M.optional(),
  attributes: eventAttributes.optional(),
  provenance: eventProvenance,
  /** Event id superseded by this envelope; existence is verified semantically. */
  correctionOf: kebabId.nullable(),
});

export type MatchEvent = z.infer<typeof matchEventSchema>;

/** Parse one canonical event envelope. Rejects unknown fields, non-finite numbers, and version drift. */
export function parseMatchEvent(input: unknown): ParseResult<MatchEvent> {
  const result = matchEventSchema.safeParse(input);
  if (!result.success) {
    const errors = toContractValidationErrors(result.error);
    const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
    if (typeof found === 'string' && found !== EVENT_SCHEMA_VERSION && /^\d+\.\d+$/.test(found)) {
      errors.unshift(unsupportedVersionError('schemaVersion', EVENT_SCHEMA_VERSION, found));
    }
    return { ok: false, errors };
  }
  if (result.data.schemaVersion !== EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        unsupportedVersionError('schemaVersion', EVENT_SCHEMA_VERSION, result.data.schemaVersion),
      ],
    };
  }
  return { ok: true, data: result.data };
}
