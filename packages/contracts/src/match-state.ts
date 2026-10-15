import { z } from 'zod';
import { confidence, SAMPLE_ORIGINS } from './data-origin';
import { type ParseResult, toContractValidationErrors } from './errors';
import { entityId, kebabId, teamId } from './ids';
import { majorMinorVersion, STATE_SCHEMA_VERSION, unsupportedVersionError } from './versioning';

/**
 * MatchState: the deterministic projection contract (docs/05 "match-state
 * projection"). This defines the *shape* the future reducer emits and every
 * lens consumes — it is not the reducer itself (KYN-04).
 *
 * TIME CONVENTION: `matchTimeMs` is absolute match-relative milliseconds on
 * the same monotonic axis as events and samples; `period` is derived context,
 * not a clock reset.
 */

export const MATCH_PERIODS = [
  'pre_match',
  'first_half',
  'half_time',
  'second_half',
  'extra_time_first',
  'extra_time_half_time',
  'extra_time_second',
  'penalty_shootout',
  'post_match',
] as const;

export type MatchPeriod = (typeof MATCH_PERIODS)[number];

export const PLAYER_STATUSES = ['on_pitch', 'substituted_off', 'sent_off'] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

export const playerState = z
  .strictObject({
    entityId: entityId,
    teamId: teamId,
    xM: z.number(),
    yM: z.number(),
    zM: z.number(),
    status: z.enum(PLAYER_STATUSES),
    /** Provenance of the *position*; facts and disclosed reconstruction only. */
    positionOrigin: z.enum(SAMPLE_ORIGINS),
    confidence: confidence,
  })
  .describe('One player in the authoritative projection');

export type PlayerState = z.infer<typeof playerState>;

export const ballState = z.strictObject({
  entityId: z.literal('ball'),
  xM: z.number(),
  yM: z.number(),
  zM: z.number(),
  positionOrigin: z.enum(SAMPLE_ORIGINS),
  confidence: confidence,
  /** Current possessor if possession is supported by the source; never guessed. */
  possessorEntityId: entityId.nullable(),
});

export type BallState = z.infer<typeof ballState>;

export const matchStateSchema = z
  .strictObject({
    schemaVersion: majorMinorVersion,
    matchId: kebabId,
    /** Monotonic projection revision; any downstream artifact pins the revision it validated against. */
    reducerRevision: z.number().int().nonnegative(),
    matchTimeMs: z.number().int().nonnegative(),
    period: z.enum(MATCH_PERIODS),
    score: z.strictObject({
      home: z.number().int().nonnegative(),
      away: z.number().int().nonnegative(),
    }),
    ball: ballState,
    players: z.array(playerState).max(30, { error: 'at most 30 players per projection' }),
    lastAcceptedEventId: kebabId.nullable(),
    source: z.strictObject({
      providerId: kebabId,
      acceptedEventCount: z.number().int().nonnegative(),
      latestSourceRevision: z.number().int().nonnegative(),
    }),
  })
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    for (const [index, player] of state.players.entries()) {
      if (seen.has(player.entityId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['players', index, 'entityId'],
          message: `duplicate player entityId "${player.entityId}"`,
        });
      }
      seen.add(player.entityId);
      if (player.entityId === 'ball') {
        ctx.addIssue({
          code: 'custom',
          path: ['players', index, 'entityId'],
          message: 'the ball is not a player; use the ball field',
        });
      }
    }
    if (state.ball.possessorEntityId !== null && !seen.has(state.ball.possessorEntityId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ball.possessorEntityId'],
        message: `possessor "${state.ball.possessorEntityId}" is not present in players`,
      });
    }
  });

export type MatchState = z.infer<typeof matchStateSchema>;

/** Parse a match-state projection document. */
export function parseMatchState(input: unknown): ParseResult<MatchState> {
  const result = matchStateSchema.safeParse(input);
  if (!result.success) {
    const errors = toContractValidationErrors(result.error);
    const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
    if (typeof found === 'string' && found !== STATE_SCHEMA_VERSION && /^\d+\.\d+$/.test(found)) {
      errors.unshift(unsupportedVersionError('schemaVersion', STATE_SCHEMA_VERSION, found));
    }
    return { ok: false, errors };
  }
  if (result.data.schemaVersion !== STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        unsupportedVersionError('schemaVersion', STATE_SCHEMA_VERSION, result.data.schemaVersion),
      ],
    };
  }
  return { ok: true, data: result.data };
}
