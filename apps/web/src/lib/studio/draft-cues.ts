import { canonicalJsonStringify } from '@kyneloom/contracts';
import type { AbsoluteCue, CompiledMomentView } from '@/lib/compiled-moment';
import type { MomentProposal } from '@kyneloom/contracts';
import type { StudioDraft } from './draft';

/**
 * KYN-17 — the DRAFT PREVIEW derivation for broadcast cues.
 *
 * The law: cue TEXT, evidence ids and metric aliases are COMPILED, VERIFIED
 * content — the client never derives a fact. What a producer may edit is the
 * editorial STRUCTURE: when an overlay's timing changes, the compiled cue is
 * re-timed to the draft interval so the overlay visibly appears/disappears at
 * the right playhead during editing. This is exactly what recompilation will
 * reproduce (the compiler regenerates cue text from evidence and takes timing
 * from the overlays); until recompile, the stage is labeled a draft preview.
 *
 * The one text exception is the caption: a hypothesis claim's editorial words
 * are the input the compiler passes through verbatim (after the number-free
 * policy, enforced at edit time), so previewing the validated draft text is
 * faithful. Metric and event cue text always stays the compiled sentence.
 */

/**
 * Cue set for the draft preview: compiled cue content re-timed onto the
 * draft's overlay intervals (absolute match clock, same law as compiledViewFrom).
 */
export function draftCues(
  compiled: CompiledMomentView,
  draft: StudioDraft,
): readonly AbsoluteCue[] {
  const momentStartMs = draft.proposal.timeRangeMs[0];
  const compiledCueById = new Map(compiled.cues.map((cue) => [cue.id, cue]));
  const cues: AbsoluteCue[] = [];
  for (const overlay of draft.proposal.overlays) {
    const base = compiledCueById.get(overlay.id);
    if (base === undefined) continue; // no compiled sentence for this overlay yet
    cues.push({
      id: base.id,
      kind: base.kind,
      startMs: momentStartMs + overlay.startMs,
      endMs: momentStartMs + overlay.endMs,
      text: captionPreviewText(base, overlay, draft.proposal),
      evidenceIds: [...base.evidenceIds],
      ...(base.metricAlias === undefined ? {} : { metricAlias: base.metricAlias }),
    });
  }
  cues.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  return cues;
}

/** Caption cues preview the draft hypothesis text (the compiler's own binding rule). */
function captionPreviewText(
  base: AbsoluteCue,
  overlay: MomentProposal['overlays'][number],
  proposal: MomentProposal,
): string {
  if (overlay.kind !== 'caption') return base.text;
  const claim = proposal.claims.find(
    (candidate) =>
      candidate.status === 'hypothesis' &&
      candidate.text !== undefined &&
      candidate.evidenceIds.some((id) => overlay.evidenceIds.includes(id)),
  );
  return claim?.text ?? base.text;
}

/** True while the draft differs from the proposal behind the compiled artifact. */
export function draftDiffersFromCompiled(
  draft: StudioDraft,
  compiledProposal: MomentProposal,
): boolean {
  return proposalDiffers(draft.proposal, compiledProposal);
}

/** Structural comparison of two proposal documents (canonical JSON identity). */
export function proposalDiffers(a: MomentProposal, b: MomentProposal): boolean {
  return canonicalJsonStringify(a) !== canonicalJsonStringify(b);
}
