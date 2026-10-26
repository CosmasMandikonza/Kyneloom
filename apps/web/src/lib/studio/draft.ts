import {
  cameraTrack,
  findUnsupportedNumericToken,
  proposalClaim,
  toContractValidationErrors,
  visualOverlay,
  type CameraKeyframe,
  type CameraTrack,
  type ContractValidationError,
  type MomentProposal,
  type VisualOverlay,
} from '@kyneloom/contracts';

/**
 * KYN-17 — the Studio editing model.
 *
 * THE LAW: a Studio draft IS a `MomentProposal v0.2.0`. There is no second
 * editing format, no shadow state and no second football truth — every edit
 * operation in this module is a PURE function that produces a new proposal
 * document, validated through the SAME contract schemas the deterministic
 * compiler enforces, BEFORE it is applied. An invalid edit is rejected with
 * exact `ContractValidationError` field paths and never partially applied.
 *
 * What may be edited (and nothing else):
 * - camera tracks: keyframe times/poses/fov, add/remove keyframes, interval,
 *   deterministic shot presets (lib/studio/presets.ts);
 * - overlay timing (start/end offsets inside the moment window);
 * - editorial channels under the number-free policy: hypothesis claim text +
 *   disclosure, and the recap headline;
 * - the audience lens selection.
 *
 * Verified claim text, evidence identities, metrics and rights are compiler
 * territory and are structurally out of reach here.
 */

export const STUDIO_DRAFT_SCHEMA_VERSION = 'kyneloom-studio-draft-v1' as const;

/** The editable document plus its revision identity (the save CAS token). */
export interface StudioDraft {
  readonly schemaVersion: typeof STUDIO_DRAFT_SCHEMA_VERSION;
  /** Stable per base proposal — the local persistence key. */
  readonly draftId: string;
  /** Incremented by the repository on every successful save (compare-and-save). */
  readonly revision: number;
  readonly proposal: MomentProposal;
}

/** Every edit either produces the next draft or names exactly what is wrong. */
export type EditResult =
  | { readonly ok: true; readonly draft: StudioDraft }
  | {
      readonly ok: false;
      readonly errors: readonly ContractValidationError[];
    };

export function createDraft(proposal: MomentProposal): StudioDraft {
  return {
    schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
    draftId: `draft-${proposal.proposalId}`,
    revision: 0,
    proposal,
  };
}

function next(draft: StudioDraft, proposal: MomentProposal): EditResult {
  return { ok: true, draft: { ...draft, proposal } };
}

/** Validate one camera track through the contract schema, rooted at its proposal path. */
function validateTrack(track: CameraTrack, rootPath: string): ContractValidationError[] {
  const parsed = cameraTrack.safeParse(track);
  if (parsed.success) return [];
  return toFieldErrors(parsed.error, rootPath);
}

function toFieldErrors(
  error: Parameters<typeof toContractValidationErrors>[0],
  rootPath: string,
): ContractValidationError[] {
  return toContractValidationErrors(error).map((validation) => ({
    ...validation,
    fieldPath: validation.fieldPath === '(root)' ? rootPath : `${rootPath}.${validation.fieldPath}`,
  }));
}

function withTrack(
  draft: StudioDraft,
  trackId: string,
  mutate: (track: CameraTrack, index: number) => CameraTrack | null,
): EditResult {
  const index = draft.proposal.cameraTracks.findIndex((track) => track.id === trackId);
  if (index === -1) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'cameraTracks',
          code: 'missing_reference',
          message: `no camera shot with id "${trackId}" exists in this draft`,
        },
      ],
    };
  }
  const current = draft.proposal.cameraTracks[index]!;
  const mutated = mutate(current, index);
  if (mutated === null) return { ok: true, draft };
  const errors = validateTrack(mutated, `cameraTracks[${index}]`);
  if (errors.length > 0) return { ok: false, errors };
  const cameraTracks = [...draft.proposal.cameraTracks];
  cameraTracks[index] = mutated;
  return next(draft, { ...draft.proposal, cameraTracks });
}

/** Mirror of the compiler's Gate 5 for scene offsets (fail before compile, same law). */
function windowEndMs(draft: StudioDraft): number {
  const [start, end] = draft.proposal.timeRangeMs;
  return end - start;
}

// ---------------------------------------------------------------------------
// Camera shot editing
// ---------------------------------------------------------------------------

/** Move a shot's [startMs, endMs] interval; keyframes must stay inside it. */
export function setShotInterval(
  draft: StudioDraft,
  trackId: string,
  startMs: number,
  endMs: number,
): EditResult {
  return withTrack(draft, trackId, (track) => ({ ...track, startMs, endMs }));
}

/** Set one keyframe's time (offset ms from the moment start). */
export function setKeyframeTime(
  draft: StudioDraft,
  trackId: string,
  keyframeIndex: number,
  tMs: number,
): EditResult {
  return withTrack(draft, trackId, (track) => {
    if (keyframeIndex < 0 || keyframeIndex >= track.keyframes.length) return null;
    const keyframes = track.keyframes.map((kf, i) => (i === keyframeIndex ? { ...kf, tMs } : kf));
    return { ...track, keyframes };
  });
}

/** Set one keyframe's camera pose (pitch meters, z up) and/or fov. */
export function setKeyframePose(
  draft: StudioDraft,
  trackId: string,
  keyframeIndex: number,
  pose: {
    readonly position?: readonly [number, number, number];
    readonly target?: readonly [number, number, number];
    readonly fovDeg?: number;
  },
): EditResult {
  return withTrack(draft, trackId, (track) => {
    if (keyframeIndex < 0 || keyframeIndex >= track.keyframes.length) return null;
    const keyframes = track.keyframes.map((kf, i) =>
      i === keyframeIndex
        ? {
            ...kf,
            ...(pose.position === undefined
              ? {}
              : {
                  position: [pose.position[0]!, pose.position[1]!, pose.position[2]!] as [
                    number,
                    number,
                    number,
                  ],
                }),
            ...(pose.target === undefined
              ? {}
              : {
                  target: [pose.target[0]!, pose.target[1]!, pose.target[2]!] as [
                    number,
                    number,
                    number,
                  ],
                }),
            ...(pose.fovDeg === undefined ? {} : { fovDeg: pose.fovDeg }),
          }
        : kf,
    );
    return { ...track, keyframes };
  });
}

/**
 * Insert a keyframe at `atMs` whose pose is the DETERMINISTIC linear blend of
 * its neighbors (or the nearest end pose at the ends). This interpolates
 * already-authored camera poses only — it never invents football geometry.
 */
export function addKeyframe(draft: StudioDraft, trackId: string, atMs: number): EditResult {
  const track = draft.proposal.cameraTracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'cameraTracks',
          code: 'missing_reference',
          message: `no camera shot with id "${trackId}" exists in this draft`,
        },
      ],
    };
  }
  if (atMs < track.startMs || atMs > track.endMs) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: `cameraTracks[${String(draft.proposal.cameraTracks.indexOf(track))}].keyframes`,
          code: 'outside_time_window',
          message: `keyframe time ${String(atMs)} ms is outside this shot's interval [${String(track.startMs)}, ${String(track.endMs)}] ms`,
        },
      ],
    };
  }
  return withTrack(draft, trackId, (current) => {
    const keyframes = [...current.keyframes];
    let insertAt = keyframes.findIndex((kf) => kf.tMs > atMs);
    if (insertAt === -1) insertAt = keyframes.length;
    const before = keyframes[Math.max(0, insertAt - 1)]!;
    const after = keyframes[Math.min(keyframes.length - 1, insertAt)]!;
    const span = after.tMs - before.tMs;
    const u = span > 0 ? Math.min(1, Math.max(0, (atMs - before.tMs) / span)) : 0;
    const blend = (a: number, b: number): number => a + (b - a) * u;
    const pose: CameraKeyframe = {
      tMs: atMs,
      position: [
        blend(before.position[0], after.position[0]),
        blend(before.position[1], after.position[1]),
        blend(before.position[2], after.position[2]),
      ],
      target: [
        blend(before.target[0], after.target[0]),
        blend(before.target[1], after.target[1]),
        blend(before.target[2], after.target[2]),
      ],
      fovDeg: Math.round(blend(before.fovDeg, after.fovDeg)),
    };
    keyframes.splice(insertAt, 0, pose);
    return { ...current, keyframes };
  });
}

/** Remove a keyframe; a track always keeps at least two. */
export function removeKeyframe(
  draft: StudioDraft,
  trackId: string,
  keyframeIndex: number,
): EditResult {
  return withTrack(draft, trackId, (track) => {
    if (track.keyframes.length <= 2) return track; // nothing to remove
    const keyframes = track.keyframes.filter((_, i) => i !== keyframeIndex);
    return { ...track, keyframes };
  });
}

/**
 * Apply a deterministic shot preset (lib/studio/presets.ts) as the shot's new
 * track. The preset keeps its own id — selection follows the new id — and the
 * draft must not exceed the contract's track budget.
 */
export function applyShotPreset(
  draft: StudioDraft,
  trackId: string,
  preset: CameraTrack,
): EditResult {
  const index = draft.proposal.cameraTracks.findIndex((track) => track.id === trackId);
  if (index === -1) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'cameraTracks',
          code: 'missing_reference',
          message: `no camera shot with id "${trackId}" exists in this draft`,
        },
      ],
    };
  }
  const errors = validateTrack(preset, `cameraTracks[${index}]`);
  if (errors.length > 0) return { ok: false, errors };
  const cameraTracks = draft.proposal.cameraTracks.map((track) =>
    track.id === trackId ? preset : track,
  );
  return next(draft, { ...draft.proposal, cameraTracks });
}

// ---------------------------------------------------------------------------
// Overlay timing
// ---------------------------------------------------------------------------

/** Set an overlay's [startMs, endMs] offsets (inside the moment window). */
export function setOverlayInterval(
  draft: StudioDraft,
  overlayId: string,
  startMs: number,
  endMs: number,
): EditResult {
  const index = draft.proposal.overlays.findIndex((overlay) => overlay.id === overlayId);
  if (index === -1) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'overlays',
          code: 'missing_reference',
          message: `no overlay with id "${overlayId}" exists in this draft`,
        },
      ],
    };
  }
  const overlay: VisualOverlay = {
    ...draft.proposal.overlays[index]!,
    startMs,
    endMs,
  };
  const parsed = visualOverlay.safeParse(overlay);
  let errors = parsed.success ? [] : toFieldErrors(parsed.error, `overlays[${index}]`);
  if (parsed.success) {
    // Mirror of the compiler's Gate 5 (overlay offsets live inside the window).
    const windowMs = windowEndMs(draft);
    if (overlay.endMs > windowMs) {
      errors = [
        {
          fieldPath: `overlays[${index}].endMs`,
          code: 'outside_time_window',
          message: `overlay ends at offset ${String(overlay.endMs)} ms, outside the ${String(windowMs)} ms moment window`,
        },
      ];
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const overlays = draft.proposal.overlays.map((current, i) => (i === index ? overlay : current));
  return next(draft, { ...draft.proposal, overlays });
}

// ---------------------------------------------------------------------------
// Editorial channels (the number-free text law)
// ---------------------------------------------------------------------------

/** Edit a hypothesis claim's editorial text (the caption's words). */
export function setHypothesisText(draft: StudioDraft, claimId: string, text: string): EditResult {
  return withClaim(draft, claimId, (claim) => ({ ...claim, text }));
}

/** Edit a hypothesis claim's inference disclosure. */
export function setHypothesisDisclosure(
  draft: StudioDraft,
  claimId: string,
  inferenceDisclosure: string,
): EditResult {
  return withClaim(draft, claimId, (claim) => ({ ...claim, inferenceDisclosure }));
}

function withClaim(
  draft: StudioDraft,
  claimId: string,
  mutate: (claim: MomentProposal['claims'][number]) => MomentProposal['claims'][number],
): EditResult {
  const index = draft.proposal.claims.findIndex((claim) => claim.id === claimId);
  if (index === -1) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'claims',
          code: 'missing_reference',
          message: `no claim with id "${claimId}" exists in this draft`,
        },
      ],
    };
  }
  const mutated = mutate(draft.proposal.claims[index]!);
  const parsed = proposalClaim.safeParse(mutated);
  if (!parsed.success) {
    return { ok: false, errors: toFieldErrors(parsed.error, `claims[${index}]`) };
  }
  const claims = draft.proposal.claims.map((claim, i) => (i === index ? parsed.data : claim));
  return next(draft, { ...draft.proposal, claims });
}

/** Edit the recap headline (editorial, number-free — it is hashed content). */
export function setRecapHeadline(draft: StudioDraft, headline: string): EditResult {
  const token = findUnsupportedNumericToken(headline);
  if (token !== null) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'recapHeadline',
          code: 'invalid_value',
          message: `headline contains the number token "${token}" — numbers are verified claims; only the deterministic compiler may put them in audience-facing text`,
        },
      ],
    };
  }
  if (headline.length < 1 || headline.length > 160) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'recapHeadline',
          code: 'too_long',
          message: 'headline must be 1–160 characters',
        },
      ],
    };
  }
  return next(draft, { ...draft.proposal, recapHeadline: headline });
}

// ---------------------------------------------------------------------------
// Audience lenses
// ---------------------------------------------------------------------------

/** Set the audience lens selection (content — it changes the compiled hash). */
export function setLenses(
  draft: StudioDraft,
  lenses: readonly MomentProposal['lenses'][number][],
): EditResult {
  if (lenses.length < 1 || lenses.length > 4) {
    return {
      ok: false,
      errors: [
        {
          fieldPath: 'lenses',
          code: 'too_short',
          message: 'at least one audience lens is required (max 4)',
        },
      ],
    };
  }
  return next(draft, { ...draft.proposal, lenses: [...lenses] });
}
