import { z } from 'zod';

/**
 * The five data origins that must never be conflated (docs/05, ADR-0003):
 *
 * - `source_observed` — reported by an external licensed tracking source.
 * - `synthetic_ground_truth` — generated simulator truth for a fictional fixture.
 * - `interpolated` — computed between known samples, with method and window.
 * - `extrapolated` — predicted outside the observed span, with uncertainty horizon.
 * - `hypothesis` — interpretation; never a physical observation.
 *
 * Which subset applies to which contract is deliberately restricted below:
 * events carry only factual origins; tracking samples may be reconstructed
 * with disclosure; hypotheses exist only in claims.
 */
export const DATA_ORIGINS = [
  'source_observed',
  'synthetic_ground_truth',
  'interpolated',
  'extrapolated',
  'hypothesis',
] as const;

export type DataOrigin = (typeof DATA_ORIGINS)[number];

/** Origins legal on a match event (physical facts and their corrections). */
export const EVENT_ORIGINS = ['source_observed', 'synthetic_ground_truth'] as const;
export type EventOrigin = (typeof EVENT_ORIGINS)[number];

/** Origins legal on a tracking sample (facts plus disclosed reconstruction). */
export const SAMPLE_ORIGINS = [
  'source_observed',
  'synthetic_ground_truth',
  'interpolated',
  'extrapolated',
] as const;
export type SampleOrigin = (typeof SAMPLE_ORIGINS)[number];

/** Truth-status classes for claims inside a manifest (docs/06). */
export const CLAIM_STATUSES = ['observed', 'calculated', 'hypothesis'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * A reconstructed sample must disclose its method; an extrapolated one must
 * additionally disclose how far beyond the observed span it reaches.
 */
export interface ReconstructionDisclosure {
  readonly method: string;
  readonly uncertaintyHorizonMs?: number;
}

export const reconstructionDisclosure = z
  .strictObject({
    method: z.string().min(1, { error: 'method must be named for reconstructed data' }),
    uncertaintyHorizonMs: z.number().int().positive().optional(),
  })
  .describe(
    'Required on interpolated/extrapolated samples; uncertaintyHorizonMs is required for extrapolated',
  );

/**
 * Sample visibility semantics (docs/05 missing-data handling): `tracked`
 * samples come from a factual origin; `partial`/`untracked` samples must be
 * explicitly reconstructed or marked absent — never silently filled.
 */
export const SAMPLE_VISIBILITIES = ['tracked', 'partial', 'untracked'] as const;
export type SampleVisibility = (typeof SAMPLE_VISIBILITIES)[number];

export const sampleVisibility = z.enum(SAMPLE_VISIBILITIES);

/** Confidence in [0, 1]; finite by construction (zod rejects NaN/Infinity). */
export const confidence = z.number().min(0).max(1);
