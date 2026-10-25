import { z } from 'zod';
import { assetUrl } from './asset-url';
import {
  type ParseResult,
  toContractValidationErrors,
  type ContractValidationError,
} from './errors';
import { kebabId, sourceHash } from './ids';
import {
  cameraTrack,
  claim,
  evidenceEntry,
  LENSES,
  MAX_CAMERA_TRACKS,
  MAX_CLAIMS,
  MAX_EVIDENCE_ENTRIES,
  MAX_OVERLAYS,
  visualOverlay,
} from './moment-manifest';
import { unsupportedVersionError } from './versioning';

/**
 * MomentProposal v0.1 — the UNTRUSTED agent output the deterministic
 * compiler validates (docs/06, docs/07, ADR-0002; issue #16).
 *
 * A proposal is what a creative agent (eventually Microsoft Foundry, KYN-15)
 * is allowed to SAY. It reuses the manifest's declarative grammar — camera
 * tracks, overlays, claims, evidence entries — but adds the parts only an
 * untrusted document needs:
 *
 * - `basedOn` — the revision identity (reducer revision + source content
 *   hash) the proposal was built against. The compiler rejects stale ones.
 * - `candidateRef` — the deterministic candidate-moment id (KYN-12 detector)
 *   the proposal claims to interpret. The compiler verifies it exists at the
 *   current revision and that the proposed window is that candidate's window.
 * - `tools` — the allowlisted read-only tools the agent used. Anything not in
 *   `PROPOSAL_TOOL_ALLOWLIST` (docs/07) is rejected; there is no field that
 *   can carry executable content, and unknown keys fail strict parsing.
 * - metric assertions — a `calculated` claim may assert ONE scalar number
 *   (`metricAssertion`) that the compiler recomputes through the metric tool
 *   boundary. The model can read numbers; it can never supply one.
 * - `assetUrls` — https-only, credential/fragment-free (assetUrl gate); the
 *   compiler additionally enforces tenant scoping.
 * - `origin` — provenance labeling. `local-deterministic` proposals are
 *   committed demo/test corpus material, never presented as agent output;
 *   `foundry-agent` is reserved for the real KYN-15 workflow.
 *
 * The trusted counterpart is the compiled MomentManifest (v0.1.0), which the
 * compiler — not the model — fills with verified numbers, source references,
 * temporal bounds and a content hash.
 *
 * TIME/SPACE: identical law to the manifest — `timeRangeMs` is absolute
 * match-relative ms; every scene offset is relative to `timeRangeMs[0]`;
 * positions are pitch meters, z up.
 */

export const PROPOSAL_SCHEMA_VERSION = '0.1.0';

/**
 * The metric kinds the deterministic tool boundary can compute
 * (`kyneloom-get-metric-v1`, KYN-12). Mirrored here so the proposal schema
 * stays dependency-free of match-core; equality is asserted by tests.
 */
export const METRIC_QUERY_KINDS = [
  'nearest-opponent',
  'separation-delta',
  'passing-lane-occupancy',
  'off-ball-movement',
] as const;
export type MetricQueryKind = (typeof METRIC_QUERY_KINDS)[number];

/** Read-only tools an agent may list (docs/07 "Important tool contracts"). */
export const PROPOSAL_TOOL_ALLOWLIST = [
  'get_metric',
  'get_event_window',
  'validate_camera_plan',
  'validate_claims',
] as const;
export type ProposalTool = (typeof PROPOSAL_TOOL_ALLOWLIST)[number];

/** Honest provenance of the proposal document itself. */
export const PROPOSAL_ORIGINS = ['local-deterministic', 'foundry-agent'] as const;
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number];

/** Flat scalar arguments; grammar per kind is validated by the compiler. */
export const metricQueryArgs = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type MetricQueryArgs = z.infer<typeof metricQueryArgs>;

/** A metric query the compiler executes through the deterministic boundary. */
export const proposalMetricQuery = z.strictObject({
  kind: z.enum(METRIC_QUERY_KINDS),
  args: metricQueryArgs,
});

/** One scalar numerical assertion a `calculated` claim makes about a metric. */
export const proposalMetricAssertion = z.strictObject({
  kind: z.enum(METRIC_QUERY_KINDS),
  args: metricQueryArgs,
  /** Which property of the metric's value object is asserted (e.g. "deltaM"). */
  valueField: z.string().min(1).max(64),
  /** The number the claim asserts; compared for exact equality. */
  assertedValue: z.number(),
});

export const proposalClaim = claim.extend({
  /**
   * Permitted only on `calculated` claims (superRefine below). The compiler
   * recomputes the metric and rejects any mismatch — an attractive-but-false
   * "the defender was 14 m away" dies here.
   */
  metricAssertion: proposalMetricAssertion.optional(),
});

export const proposalEvidence = evidenceEntry.extend({
  /**
   * Required for `derived_metric` evidence (superRefine below): the query the
   * compiler executes to establish the number. Absent for source events and
   * raw tracking windows, which are verified by direct lookup.
   */
  metricQuery: proposalMetricQuery.optional(),
});

export const momentProposalSchema = z
  .strictObject({
    schemaVersion: z.literal(PROPOSAL_SCHEMA_VERSION),
    proposalId: kebabId,
    origin: z.enum(PROPOSAL_ORIGINS),
    /** Free-text labeling note (e.g. corpus description); never rendered as fact. */
    originNote: z.string().min(1).max(200).optional(),
    tenantId: kebabId,
    matchId: kebabId,
    /** The KYN-12 candidate this proposal interprets; verified by the compiler. */
    candidateRef: kebabId,
    basedOn: z.strictObject({
      reducerRevision: z.number().int().nonnegative(),
      sourceHash: sourceHash,
    }),
    /** Absolute match-relative milliseconds [start, end). */
    timeRangeMs: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    /**
     * Tools the agent used. Free strings at schema level so an unknown tool
     * produces a precise `unknown_command` compiler error naming it — the
     * allowlist itself is enforced by the compiler against
     * PROPOSAL_TOOL_ALLOWLIST.
     */
    tools: z.array(z.string().min(1).max(64)).max(8),
    cameraTracks: z.array(cameraTrack).max(MAX_CAMERA_TRACKS),
    overlays: z.array(visualOverlay).max(MAX_OVERLAYS),
    claims: z.array(proposalClaim).max(MAX_CLAIMS),
    evidence: z.array(proposalEvidence).max(MAX_EVIDENCE_ENTRIES),
    lenses: z
      .array(z.enum(LENSES))
      .min(1, { error: 'at least one audience lens is required' })
      .max(4),
    rightsPolicyRef: z.string().min(1),
    assetUrls: z.array(assetUrl).max(32),
    /** Editorial recap headline; recap lines are derived from verified claims. */
    recapHeadline: z.string().min(1).max(160),
  })
  .superRefine((proposal, ctx) => {
    const [startMs, endMs] = proposal.timeRangeMs;
    if (endMs <= startMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeRangeMs'],
        message: 'timeRangeMs end must be after start',
      });
    }

    // Derived-metric evidence must name the computation it claims to cite —
    // otherwise the compiler would have nothing deterministic to verify.
    for (const [index, entry] of proposal.evidence.entries()) {
      if (entry.kind === 'derived_metric' && entry.metricQuery === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', index, 'metricQuery'],
          message: 'derived_metric evidence must carry the metricQuery that computes it',
        });
      }
      if (entry.kind !== 'derived_metric' && entry.metricQuery !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', index, 'metricQuery'],
          message: `metricQuery is only meaningful on derived_metric evidence (this entry is "${entry.kind}")`,
        });
      }
    }

    // Numerical assertions are the calculated-claim channel only: observed
    // facts come from source events, hypotheses must stay qualitative.
    for (const [index, c] of proposal.claims.entries()) {
      if (c.metricAssertion !== undefined && c.status !== 'calculated') {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', index, 'metricAssertion'],
          message: `metricAssertion is only permitted on "calculated" claims (this claim is "${c.status}")`,
        });
      }
    }

    // Everything cited inside the scene must be declared in this proposal.
    const evidenceIds = new Set(proposal.evidence.map((entry) => entry.id));
    for (const [overlayIndex, overlay] of proposal.overlays.entries()) {
      for (const [pos, id] of overlay.evidenceIds.entries()) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['overlays', overlayIndex, 'evidenceIds', pos],
            message: `cites evidence "${id}" which is not declared in this proposal`,
          });
        }
      }
    }
    for (const [claimIndex, c] of proposal.claims.entries()) {
      for (const [pos, id] of c.evidenceIds.entries()) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['claims', claimIndex, 'evidenceIds', pos],
            message: `cites evidence "${id}" which is not declared in this proposal`,
          });
        }
      }
    }
  });

export type MomentProposal = z.infer<typeof momentProposalSchema>;
export type ProposalClaim = z.infer<typeof proposalClaim>;
export type ProposalEvidence = z.infer<typeof proposalEvidence>;
export type ProposalMetricAssertion = z.infer<typeof proposalMetricAssertion>;
export type ProposalMetricQuery = z.infer<typeof proposalMetricQuery>;

/** Parse an untrusted MomentProposal document (schema level only). */
export function parseMomentProposal(input: unknown): ParseResult<MomentProposal> {
  const result = momentProposalSchema.safeParse(input);
  if (!result.success) {
    const errors: ContractValidationError[] = toContractValidationErrors(result.error);
    const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
    if (
      typeof found === 'string' &&
      found !== PROPOSAL_SCHEMA_VERSION &&
      /^\d+\.\d+\.\d+$/.test(found)
    ) {
      errors.unshift(unsupportedVersionError('schemaVersion', PROPOSAL_SCHEMA_VERSION, found));
    }
    return { ok: false, errors };
  }
  return { ok: true, data: result.data };
}
