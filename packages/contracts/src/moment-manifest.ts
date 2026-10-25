import { z } from 'zod';
import { CLAIM_STATUSES } from './data-origin';
import { type ParseResult, toContractValidationErrors } from './errors';
import { kebabId, languageTag, sourceHash } from './ids';
import { MAX_ABS_COORDINATE_M, PITCH_COORDINATE_SYSTEM, vec3TupleM } from './spatial';
import {
  MANIFEST_SCHEMA_VERSION,
  migrateDocument,
  semver,
  unsupportedVersionError,
} from './versioning';

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
    // Finite-but-huge coordinates are just as unusable as NaN for a camera;
    // the same safe radius as tracking applies to positions and targets.
    for (const [field, values] of [
      ['position', kf.position],
      ['target', kf.target],
    ] as const) {
      for (const [axis, value] of values.entries()) {
        if (Math.abs(value) > MAX_ABS_COORDINATE_M) {
          ctx.addIssue({
            code: 'custom',
            path: [field, axis],
            message: `camera ${field} axis ${axis} exceeds the ${MAX_ABS_COORDINATE_M} m safe radius around the pitch`,
          });
        }
      }
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
      // Keyframes must also fall inside THIS track's interval — a keyframe
      // outside the track's own [startMs, endMs] would never be played.
      if (kf.tMs < track.startMs || kf.tMs > track.endMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', index, 'tMs'],
          message: `keyframe at ${kf.tMs} ms is outside this camera track's interval [${track.startMs}, ${track.endMs}] ms`,
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

/**
 * ---------------------------------------------------------------------------
 * Presentation section (schema v0.2.0, KYN-16 review blocker B).
 *
 * One manifest identifies ONE audience experience: the broadcast cues and
 * recap the viewers see live inside this content-addressed section, so the
 * single approval hash (approvalContentPayload already spreads every content
 * field) covers everything a user can read or watch. Compiler output always
 * carries it; migrated 0.1.0 documents legitimately have none (no audience
 * text exists for them).
 *
 * CLOCK LAW: like the scene section, cue times are OFFSETS from
 * `timeRangeMs[0]` — consumers convert to the absolute match clock exactly
 * once, at the presentation boundary.
 *
 * TEXT LAW: cue and recap text is compiler-authored — verified numbers come
 * from the deterministic metric/event facts, editorial lines from
 * number-free hypothesis claims (see contracts/editorial-text.ts).
 */

/** Version of the presentation grammar itself (a formatter change re-identities). */
export const PRESENTATION_VERSION = 'kyneloom-presentation-v1' as const;

export const BROADCAST_CUE_KINDS = ['metric', 'caption', 'event_marker'] as const;
export type BroadcastCueKind = (typeof BROADCAST_CUE_KINDS)[number];

/** A time-coded overlay cue whose text is part of the hashed artifact. */
export const broadcastCue = z
  .strictObject({
    id: kebabId,
    kind: z.enum(BROADCAST_CUE_KINDS),
    /** Offsets from moment start. */
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    /** Compiler-authored audience text (verified fact or editorial claim). */
    text: z.string().min(1).max(400),
    evidenceIds: z.array(kebabId).max(16),
    /** The verified metric a metric cue renders, by manifest alias. */
    metricAlias: kebabId.optional(),
  })
  .superRefine((cue, ctx) => {
    if (cue.endMs < cue.startMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['endMs'],
        message: 'endMs must not precede startMs',
      });
    }
  });

export type BroadcastCue = z.infer<typeof broadcastCue>;

/** One recap line mirroring a manifest claim. */
export const recapLine = z.strictObject({
  claimId: kebabId,
  text: z.string().min(1).max(1000),
  status: z.enum(CLAIM_STATUSES),
  evidenceIds: z.array(kebabId).max(16),
  /** Required when (and only when) the mirrored claim is a hypothesis. */
  inferenceDisclosure: z.string().min(1).max(1000).optional(),
});

export type RecapLine = z.infer<typeof recapLine>;

export const manifestPresentation = z.strictObject({
  presentationVersion: z.literal(PRESENTATION_VERSION),
  broadcast: z.array(broadcastCue).max(MAX_OVERLAYS),
  recap: z.strictObject({
    /** Editorial, number-free (the editorial-text policy applies at compile). */
    headline: z.string().min(1).max(160),
    lines: z.array(recapLine).max(MAX_CLAIMS),
  }),
});

export type ManifestPresentation = z.infer<typeof manifestPresentation>;

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
    /** Audience-facing broadcast cues + recap (v0.2.0; always set by the compiler). */
    presentation: manifestPresentation.optional(),
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

    // Presentation cues obey the same offset clock law as the scene, and
    // recap lines may only mirror claims this manifest declares.
    if (manifest.presentation !== undefined) {
      for (const [cueIndex, cue] of manifest.presentation.broadcast.entries()) {
        if (cue.endMs > windowMs) {
          ctx.addIssue({
            code: 'custom',
            path: ['presentation', 'broadcast', cueIndex, 'endMs'],
            message: `broadcast cue ends at offset ${cue.endMs} ms, outside the ${windowMs} ms moment window`,
          });
        }
      }
      const claimIds = new Set(manifest.claims.map((claim) => claim.id));
      for (const [lineIndex, line] of manifest.presentation.recap.lines.entries()) {
        if (!claimIds.has(line.claimId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['presentation', 'recap', 'lines', lineIndex, 'claimId'],
            message: `recap line cites claim "${line.claimId}" which this manifest does not declare`,
          });
        }
        const mirrored = manifest.claims.find((claim) => claim.id === line.claimId);
        if (
          mirrored !== undefined &&
          mirrored.status === 'hypothesis' &&
          line.inferenceDisclosure === undefined
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['presentation', 'recap', 'lines', lineIndex, 'inferenceDisclosure'],
            message: 'recap lines mirroring hypothesis claims must carry the disclosure',
          });
        }
      }
    }

    // Collection ids must be unique within their collection: repeated ids
    // make producer edits, scene selection and provenance resolution
    // ambiguous. The offending duplicate is reported at its own position.
    assertUniqueIds(
      ctx,
      manifest.scene.cameraTracks.map((track) => track.id),
      (index) => ['scene', 'cameraTracks', index, 'id'],
      'camera track',
    );
    assertUniqueIds(
      ctx,
      manifest.scene.overlays.map((overlay) => overlay.id),
      (index) => ['scene', 'overlays', index, 'id'],
      'overlay',
    );
    assertUniqueIds(
      ctx,
      manifest.claims.map((c) => c.id),
      (index) => ['claims', index, 'id'],
      'claim',
    );
    assertUniqueIds(
      ctx,
      manifest.evidence.map((entry) => entry.id),
      (index) => ['evidence', index, 'id'],
      'evidence entry',
    );

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
  // Registered older versions upgrade through MIGRATIONS (docs/06 policy);
  // unregistered versions fail closed with the expected value named.
  const found = (input as Record<string, unknown> | null)?.['schemaVersion'];
  let document = input;
  if (typeof found === 'string' && found !== MANIFEST_SCHEMA_VERSION) {
    const migrated = migrateDocument(input, MANIFEST_SCHEMA_VERSION);
    if (migrated.ok) {
      document = migrated.document;
    } else {
      const result = momentManifestSchema.safeParse(input);
      const errors = result.success ? [] : toContractValidationErrors(result.error);
      if (semver.safeParse(found).success) {
        errors.unshift(unsupportedVersionError('schemaVersion', MANIFEST_SCHEMA_VERSION, found));
      }
      return { ok: false, errors };
    }
  }
  const result = momentManifestSchema.safeParse(document);
  if (!result.success) {
    const errors = toContractValidationErrors(result.error);
    const foundAfterMigration =
      (document as Record<string, unknown> | null)?.['schemaVersion'] ?? found;
    if (
      typeof foundAfterMigration === 'string' &&
      foundAfterMigration !== MANIFEST_SCHEMA_VERSION &&
      /^\d+\.\d+\.\d+$/.test(foundAfterMigration)
    ) {
      errors.unshift(
        unsupportedVersionError('schemaVersion', MANIFEST_SCHEMA_VERSION, foundAfterMigration),
      );
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

/**
 * The exact object hashed for approval (KYN-02 review): every immutable,
 * content-bearing field of the manifest — **excluding `status`** (mutable
 * workflow state: draft → validating → … → published) and **excluding
 * `approval` itself** (it carries the resulting `manifestHash`; hashing it
 * would be circular and would change the hash on every approval step).
 *
 * The publication service computes `sha256(canonicalJsonStringify(
 * approvalContentPayload(manifest)))` server-side; both founders hash this
 * same object, so `approved`, `published` and re-approved revisions of
 * identical content share one hash, while any edit (a single claim, camera
 * keyframe, evidence entry…) changes it.
 */
export interface ApprovalContentPayload {
  readonly schemaVersion: string;
  readonly manifestId: string;
  readonly tenantId: string;
  readonly matchId: string;
  readonly revision: number;
  readonly timeRangeMs: readonly [number, number];
  readonly input: MomentManifest['input'];
  readonly scene: MomentManifest['scene'];
  readonly claims: readonly Claim[];
  readonly evidence: readonly EvidenceEntry[];
  readonly lenses: readonly Lens[];
  readonly rightsPolicyRef: string;
  /**
   * Audience-facing cues + recap (v0.2.0): the runtime payload spreads it in
   * (everything except status/approval), so the declared type must list it —
   * future publish code cannot accidentally drop it from the hashed identity.
   * Absent only on stamp-migrated v0.1.0 documents.
   */
  readonly presentation?: ManifestPresentation;
}

export function approvalContentPayload(manifest: MomentManifest): ApprovalContentPayload {
  const { status: _status, approval: _approval, ...content } = manifest;
  return content;
}

/** Report duplicated collection ids at the position of each repetition. */
function assertUniqueIds(
  ctx: z.RefinementCtx,
  ids: readonly string[],
  pathFor: (index: number) => PropertyKey[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: pathFor(index),
        message: `duplicate ${label} id "${id}"; ids must be unique within their collection`,
      });
    }
    seen.add(id);
  }
}
