import { z } from 'zod';
import { CLAIM_STATUSES } from './data-origin';
import { type ParseResult, toContractValidationErrors } from './errors';
import { kebabId, languageTag, sourceHash } from './ids';
import { PITCH_COORDINATE_SYSTEM, vec3TupleM } from './spatial';
import { MANIFEST_SCHEMA_VERSION, semver, unsupportedVersionError } from './versioning';

/**
 * MomentManifest: the versioned, declarative scene proposal (docs/06,
 * ADR-0002). Agents compose these; a deterministic compiler validates them;
 * viewers render allowlisted operations. There is **no field in this schema
 * that can carry executable content**, and unknown keys are rejected.
 *
 * TIME CONVENTIONS — two distinct axes, never conflated:
 * - `timeRangeMs` is a pair of **absolute match-relative milliseconds** on
 *   the same axis as events/samples (e.g. [4717000, 4731000]).
 * - Every `startMs`/`endMs`/`tMs` inside `scene` is an **offset relative to
 *   `timeRangeMs[0]`** (the beginning of the moment). A 14 s moment whose
 *   camera track ends at `endMs: 14000` is in-window; `4731000` would be a
 *   category error and is rejected.
 *
 * SPACE: all scene positions/targets are pitch meters (z up), converted to
 * Three.js space only through the shared `pitchToThree` transform.
 */

/** Safe bounds (issue KYN-02: "safe bounds for arrays/time"). */
export const MAX_MOMENT_WINDOW_MS = 120_000;
export const MIN_MOMENT_WINDOW_MS = 500;
export const MAX_CAMERA_KEYFRAMES = 64;
export const MAX_CAMERA_TRACKS = 16;
export const MAX_OVERLAYS = 64;
export const MAX_CLAIMS = 128;
export const MAX_EVIDENCE_ENTRIES = 256;
export const CAMERA_FOV_RANGE_DEG = { min: 20, max: 120 } as const;
export const MIN_CAMERA_HEIGHT_M = 0.5;

export const CAMERA_MODES = [
  'overhead',
  'broadcast',
  'player_follow',
  'goalkeeper',
  'free_orbit',
  'directed',
] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

export const OVERLAY_KINDS = [
  'distance',
  'trajectory',
  'zone',
  'event_marker',
  'caption',
  'source_quality',
] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const EVIDENCE_KINDS = ['derived_metric', 'source_event', 'tracking_samples'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const LENSES = ['fan', 'analyst', 'accessible', 'producer_preview'] as const;
export type Lens = (typeof LENSES)[number];

export const MANIFEST_STATUSES = [
  'draft',
  'validating',
  'needs_revision',
  'awaiting_approval',
  'approved',
  'published',
  'revoked',
] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

/** Statuses a client-side editor may set; approval must be null in all of them. */
const CLIENT_EDITABLE_STATUSES = [
  'draft',
  'validating',
  'needs_revision',
  'awaiting_approval',
] as const;

export const cameraKeyframe = z
  .strictObject({
    /** Offset from the start of the moment window, in milliseconds. */
    tMs: z.number().int().nonnegative(),
    position: vec3TupleM,
    target: vec3TupleM,
    fovDeg: z
      .number()
      .int()
      .min(CAMERA_FOV_RANGE_DEG.min, { error: `fovDeg must be >= ${CAMERA_FOV_RANGE_DEG.min}` })
      .max(CAMERA_FOV_RANGE_DEG.max, { error: `fovDeg must be <= ${CAMERA_FOV_RANGE_DEG.max}` }),
  })
  .superRefine((kf, ctx) => {
    if (kf.position[2] < MIN_CAMERA_HEIGHT_M) {
      ctx.addIssue({
        code: 'custom',
        path: ['position', 2],
        message: `camera must stay at least ${MIN_CAMERA_HEIGHT_M} m above the pitch plane`,
      });
    }
    if (kf.target[2] < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['target', 2],
        message: 'target must not be below the pitch plane',
      });
    }
  });

export type CameraKeyframe = z.infer<typeof cameraKeyframe>;

export const cameraTrack = z
  .strictObject({
    id: kebabId,
    mode: z.enum(CAMERA_MODES),
    /** Offsets from moment start. */
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    keyframes: z
      .array(cameraKeyframe)
      .min(2, { error: 'a camera track needs at least two keyframes' })
      .max(MAX_CAMERA_KEYFRAMES),
  })
  .superRefine((track, ctx) => {
    if (track.endMs < track.startMs) {
      ctx.addIssue({ code: 'custom', path: ['endMs'], message: 'endMs must not precede startMs' });
    }
    for (const [index, kf] of track.keyframes.entries()) {
      if (index > 0 && kf.tMs <= track.keyframes[index - 1]!.tMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', index, 'tMs'],
          message: 'keyframe times must be strictly increasing',
        });
      }
    }
  });

export type CameraTrack = z.infer<typeof cameraTrack>;

export const visualOverlay = z
  .strictObject({
    id: kebabId,
    kind: z.enum(OVERLAY_KINDS),
    /** Offsets from moment start. */
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    /** Deterministic metric reference; existence is verified semantically. */
    metricRef: kebabId.optional(),
    evidenceIds: z.array(kebabId).max(16),
  })
  .superRefine((overlay, ctx) => {
    if (overlay.endMs < overlay.startMs) {
      ctx.addIssue({ code: 'custom', path: ['endMs'], message: 'endMs must not precede startMs' });
    }
    if (overlay.kind !== 'caption' && overlay.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: `overlays of kind "${overlay.kind}" must cite at least one evidence entry (captions may be editorial)`,
      });
    }
  });

export type VisualOverlay = z.infer<typeof visualOverlay>;

export const claim = z
  .strictObject({
    id: kebabId,
    text: z.string().min(1).max(1000),
    status: z.enum(CLAIM_STATUSES),
    evidenceIds: z.array(kebabId).max(16),
    language: languageTag,
    /** Required for hypotheses; documents what is interpretation, not observation. */
    inferenceDisclosure: z.string().min(1).max(1000).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.status === 'hypothesis') {
      if (!c.inferenceDisclosure) {
        ctx.addIssue({
          code: 'custom',
          path: ['inferenceDisclosure'],
          message: 'hypothesis claims must disclose their inferential nature',
        });
      }
    } else if (c.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceIds'],
        message: `"${c.status}" claims must cite at least one evidence entry`,
      });
    }
  });

export type Claim = z.infer<typeof claim>;

export const evidenceEntry = z.strictObject({
  id: kebabId,
  kind: z.enum(EVIDENCE_KINDS),
  /** Points at a metric, source event id, or sample-window id — resolved semantically. */
  ref: kebabId,
  algorithmVersion: z.string().min(1).optional(),
  inputRefs: z.array(kebabId).min(1, { error: 'evidence must name its inputs' }).max(64),
});

export type EvidenceEntry = z.infer<typeof evidenceEntry>;

/**
 * Server-issued approval record. Clients can type-check it but must never
 * mint it: only the publication service creates approvals after its own
 * validation, bound to the exact manifest hash (ADR-0002, docs/06 gate 7).
 */
export const approvalRecord = z.strictObject({
  approvedBy: kebabId,
  approvedAt: z.iso.datetime({ offset: false }),
  manifestHash: sourceHash,
  policyVersion: z.string().min(1),
});

export type ApprovalRecord = z.infer<typeof approvalRecord>;

/** An immutable, revocable release issued by the publication service. */
export const releaseRecord = z
  .strictObject({
    releaseId: kebabId,
    manifestId: kebabId,
    manifestHash: sourceHash,
    approvedBy: kebabId,
    approvedAt: z.iso.datetime({ offset: false }),
    policyVersion: z.string().min(1),
    status: z.enum(['published', 'revoked']),
    revokedAt: z.iso.datetime({ offset: false }).optional(),
    revocationReason: z.string().min(1).optional(),
  })
  .superRefine((release, ctx) => {
    if (release.status === 'revoked') {
      if (!release.revokedAt || !release.revocationReason) {
        ctx.addIssue({
          code: 'custom',
          path: ['revokedAt'],
          message: 'revoked releases must record when and why',
        });
      }
    } else if (release.revokedAt || release.revocationReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'only revoked releases carry revocation fields',
      });
    }
  });

export type ReleaseRecord = z.infer<typeof releaseRecord>;

export const momentManifestSchema = z
  .strictObject({
    schemaVersion: semver,
    manifestId: kebabId,
    tenantId: kebabId,
    matchId: kebabId,
    /** Editor draft revision; approval always refers to a specific revision + hash. */
    revision: z.number().int().nonnegative(),
    status: z.enum(MANIFEST_STATUSES),
    /** Absolute match-relative milliseconds [start, end). */
    timeRangeMs: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    input: z.strictObject({
      reducerRevision: z.number().int().nonnegative(),
      sourceEventIds: z.array(kebabId).max(256),
      trackingSampleRefs: z.array(kebabId).max(2048),
      sourceHash: sourceHash,
    }),
    scene: z.strictObject({
      coordinateSystem: z.literal(PITCH_COORDINATE_SYSTEM),
      cameraTracks: z.array(cameraTrack).max(MAX_CAMERA_TRACKS),
      overlays: z.array(visualOverlay).max(MAX_OVERLAYS),
    }),
    claims: z.array(claim).max(MAX_CLAIMS),
    evidence: z.array(evidenceEntry).max(MAX_EVIDENCE_ENTRIES),
    lenses: z
      .array(z.enum(LENSES))
      .min(1, { error: 'at least one audience lens is required' })
      .max(4),
    rightsPolicyRef: z.string().min(1),
    /** Null until the publication service issues an approval for this exact revision. */
    approval: approvalRecord.nullable(),
  })
  .superRefine((manifest, ctx) => {
    const [startMs, endMs] = manifest.timeRangeMs;
    const windowMs = endMs - startMs;
    if (windowMs < MIN_MOMENT_WINDOW_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeRangeMs'],
        message: `moment window must be at least ${MIN_MOMENT_WINDOW_MS} ms`,
      });
    }
    if (windowMs > MAX_MOMENT_WINDOW_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeRangeMs'],
        message: `moment window must be at most ${MAX_MOMENT_WINDOW_MS} ms`,
      });
    }

    for (const [trackIndex, track] of manifest.scene.cameraTracks.entries()) {
      if (track.endMs > windowMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['scene', 'cameraTracks', trackIndex, 'endMs'],
          message: `camera track ends at ${track.endMs} ms, outside the ${windowMs} ms moment window (offsets are relative to moment start)`,
        });
      }
      for (const [kfIndex, kf] of track.keyframes.entries()) {
        if (kf.tMs > windowMs) {
          ctx.addIssue({
            code: 'custom',
            path: ['scene', 'cameraTracks', trackIndex, 'keyframes', kfIndex, 'tMs'],
            message: `keyframe at ${kf.tMs} ms is outside the ${windowMs} ms moment window (offsets are relative to moment start)`,
          });
        }
      }
    }

    for (const [overlayIndex, overlay] of manifest.scene.overlays.entries()) {
      if (overlay.endMs > windowMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['scene', 'overlays', overlayIndex, 'endMs'],
          message: `overlay ends at ${overlay.endMs} ms, outside the ${windowMs} ms moment window`,
        });
      }
    }

    // Internal referential integrity: everything cited must be declared in
    // this manifest. Whether evidence refs exist in the reducer revision,
    // metrics registry, or tenant rights is SEMANTIC verification (below).
    const evidenceIds = new Set(manifest.evidence.map((entry) => entry.id));
    for (const [overlayIndex, overlay] of manifest.scene.overlays.entries()) {
      for (const [pos, id] of overlay.evidenceIds.entries()) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scene', 'overlays', overlayIndex, 'evidenceIds', pos],
            message: `cites evidence "${id}" which is not declared in this manifest`,
          });
        }
      }
    }
    for (const [claimIndex, c] of manifest.claims.entries()) {
      for (const [pos, id] of c.evidenceIds.entries()) {
        if (!evidenceIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['claims', claimIndex, 'evidenceIds', pos],
            message: `cites evidence "${id}" which is not declared in this manifest`,
          });
        }
      }
    }

    const uniqueLenses = new Set(manifest.lenses);
    if (uniqueLenses.size !== manifest.lenses.length) {
      ctx.addIssue({ code: 'custom', path: ['lenses'], message: 'lenses must be unique' });
    }

    // Approval semantics: client-editable statuses carry no approval;
    // server-authorized statuses must carry one.
    const clientEditable = (CLIENT_EDITABLE_STATUSES as readonly string[]).includes(
      manifest.status,
    );
    if (clientEditable && manifest.approval !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: `status "${manifest.status}" is client-editable and must not carry a server approval`,
      });
    }
    if (!clientEditable && manifest.approval === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: `status "${manifest.status}" requires the server-issued approval record`,
      });
    }
  });

export type MomentManifest = z.infer<typeof momentManifestSchema>;

/** Parse a MomentManifest draft or approved document. */
export function parseMomentManifest(input: unknown): ParseResult<MomentManifest> {
  const result = momentManifestSchema.safeParse(input);
  if (!result.success) {
    const errors = toContractValidationErrors(result.error);
    const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
    if (
      typeof found === 'string' &&
      found !== MANIFEST_SCHEMA_VERSION &&
      /^\d+\.\d+\.\d+$/.test(found)
    ) {
      errors.unshift(unsupportedVersionError('schemaVersion', MANIFEST_SCHEMA_VERSION, found));
    }
    return { ok: false, errors };
  }
  if (result.data.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        unsupportedVersionError(
          'schemaVersion',
          MANIFEST_SCHEMA_VERSION,
          result.data.schemaVersion,
        ),
      ],
    };
  }
  return { ok: true, data: result.data };
}

/** Parse a server-issued release record. */
export function parseReleaseRecord(input: unknown): ParseResult<ReleaseRecord> {
  const result = releaseRecord.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, errors: toContractValidationErrors(result.error) };
}

/**
 * Canonical JSON serialization (sorted object keys, no whitespace) used to
 * fingerprint manifests and inputs deterministically. Hashing (sha256) is
 * intentionally NOT done here — contracts stay free of server-only APIs —
 * the publication service hashes this string.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value);

  function serialize(node: unknown): string {
    if (node === null || typeof node === 'number' || typeof node === 'boolean')
      return JSON.stringify(node);
    if (typeof node === 'string') return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(serialize).join(',')}]`;
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
      return `{${entries.join(',')}}`;
    }
    throw new TypeError(`cannot canonicalize value of type ${typeof node}`);
  }
}

/**
 * The input fingerprint a semantic verifier re-checks: if this string
 * changes (source events, sample refs, reducer revision, source hash), every
 * derived validation and approval for the manifest is stale and must re-run.
 */
export function manifestInputFingerprint(manifest: MomentManifest): string {
  return canonicalJsonStringify({
    reducerRevision: manifest.input.reducerRevision,
    sourceEventIds: [...manifest.input.sourceEventIds].sort(),
    trackingSampleRefs: [...manifest.input.trackingSampleRefs].sort(),
    sourceHash: manifest.input.sourceHash,
  });
}
