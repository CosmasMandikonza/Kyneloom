import { z } from 'zod';
import {
  confidence,
  reconstructionDisclosure,
  SAMPLE_ORIGINS,
  SAMPLE_VISIBILITIES,
} from './data-origin';
import { type ParseResult, toContractValidationErrors } from './errors';
import { entityId, kebabId } from './ids';
import { MAX_ABS_COORDINATE_M } from './spatial';
import { majorMinorVersion, TRACKING_SCHEMA_VERSION, unsupportedVersionError } from './versioning';

/**
 * Canonical tracking sample (docs/05 "position tracking sample").
 *
 * Identity: a sample belongs to the ball (`"ball"`) or one player
 * (`"home-04"`). Nothing in the schema assumes players — ball and player
 * streams are explicit, distinguished by {@link isBallEntity}.
 *
 * TIME CONVENTION: `sampleTimeMs` is absolute match-relative milliseconds,
 * same axis as `MatchEvent.occurredAtMs`.
 *
 * MISSING-DATA SEMANTICS: `visibility` and `origin` are coupled. `tracked`
 * requires a factual origin (`source_observed` or `synthetic_ground_truth`).
 * `partial`/`untracked` require an explicitly disclosed reconstruction
 * (`interpolated` with a method, or `extrapolated` with a method plus an
 * uncertainty horizon). Absent data is represented by the *absence of
 * samples*, never by fabricated coordinates.
 */

const boundedCoordinate = z.number().refine((n) => Math.abs(n) <= MAX_ABS_COORDINATE_M, {
  error: `coordinates must stay within ${MAX_ABS_COORDINATE_M} m of the pitch origin`,
});

export const trackingSampleSchema = z
  .strictObject({
    schemaVersion: majorMinorVersion,
    matchId: kebabId,
    sampleTimeMs: z.number().int().nonnegative(),
    entityId: entityId,
    xM: boundedCoordinate,
    yM: boundedCoordinate,
    zM: boundedCoordinate,
    origin: z.enum(SAMPLE_ORIGINS),
    confidence: confidence,
    visibility: z.enum(SAMPLE_VISIBILITIES),
    sourceFrameId: z.string().min(1, { error: 'must reference the source frame' }),
    /** Required when origin is interpolated/extrapolated; forbidden otherwise. */
    reconstruction: reconstructionDisclosure.optional(),
  })
  .superRefine((sample, ctx) => {
    const factual =
      sample.origin === 'source_observed' || sample.origin === 'synthetic_ground_truth';
    if (sample.visibility === 'tracked' && !factual) {
      ctx.addIssue({
        code: 'custom',
        path: ['origin'],
        message: `visibility "tracked" requires a factual origin (source_observed or synthetic_ground_truth), got "${sample.origin}"`,
      });
    }
    if (!factual) {
      if (!sample.reconstruction) {
        ctx.addIssue({
          code: 'custom',
          path: ['reconstruction'],
          message: `origin "${sample.origin}" must disclose its reconstruction method`,
        });
      } else if (
        sample.origin === 'extrapolated' &&
        sample.reconstruction.uncertaintyHorizonMs === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['reconstruction.uncertaintyHorizonMs'],
          message: 'extrapolated samples must disclose an uncertainty horizon in milliseconds',
        });
      }
    }
    if (factual && sample.reconstruction) {
      ctx.addIssue({
        code: 'custom',
        path: ['reconstruction'],
        message: `factual origin "${sample.origin}" must not carry a reconstruction disclosure`,
      });
    }
  });

export type TrackingSample = z.infer<typeof trackingSampleSchema>;

/** Parse one tracking sample (player or ball — check with {@link isBallEntity}). */
export function parseTrackingSample(input: unknown): ParseResult<TrackingSample> {
  const result = trackingSampleSchema.safeParse(input);
  if (!result.success) {
    const errors = toContractValidationErrors(result.error);
    const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
    if (
      typeof found === 'string' &&
      found !== TRACKING_SCHEMA_VERSION &&
      /^\d+\.\d+$/.test(found)
    ) {
      errors.unshift(unsupportedVersionError('schemaVersion', TRACKING_SCHEMA_VERSION, found));
    }
    return { ok: false, errors };
  }
  if (result.data.schemaVersion !== TRACKING_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        unsupportedVersionError(
          'schemaVersion',
          TRACKING_SCHEMA_VERSION,
          result.data.schemaVersion,
        ),
      ],
    };
  }
  return { ok: true, data: result.data };
}
