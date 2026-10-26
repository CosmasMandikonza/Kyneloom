import { parseMomentProposal, type MomentProposal } from '@kyneloom/contracts';
import { STUDIO_DRAFT_SCHEMA_VERSION, type StudioDraft } from './draft';

/**
 * KYN-17 — the Studio draft repository.
 *
 * SECURITY REALITY (docs/10, KYN-21 pending): there is NO authenticated
 * server-side persistence for producer drafts yet. This milestone ships a
 * clearly-labeled LOCAL DEMONSTRATION EDITING MODE: drafts persist in the
 * browser's own storage, atomic and versioned, and are explicitly NOT shared
 * cloud production projects. The interface below is the seam a future
 * authorized server adapter implements without rewriting the editor — the
 * editor code never talks to storage directly.
 *
 * Compare-and-save law: `save(draft, expectedRevision)` succeeds ONLY when
 * the stored revision equals `expectedRevision` (or nothing is stored yet);
 * it then stores the draft at `expectedRevision + 1` and returns the new
 * revision. A concurrent editor (another tab) that saved first produces a
 * CONFLICT result naming the stored revision — never a silent overwrite.
 */

/** The persisted record: schema-validated on write AND on load (fail closed). */
export interface StoredDraftRecord {
  readonly schemaVersion: typeof STUDIO_DRAFT_SCHEMA_VERSION;
  readonly draftId: string;
  readonly revision: number;
  readonly savedAt: string;
  readonly proposal: MomentProposal;
}

export type LoadOutcome =
  | { readonly ok: true; readonly draft: StudioDraft; readonly savedAt: string }
  | { readonly ok: false; readonly kind: 'invalid'; readonly message: string };

export type SaveOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly kind: 'conflict'; readonly currentRevision: number };

export interface StudioDraftRepository {
  /** The stored draft for this id, or null when none exists. A corrupt record REJECTS (never coerced). */
  load(draftId: string): Promise<LoadOutcome | null>;
  /** Atomic compare-and-save. */
  save(draft: StudioDraft, expectedRevision: number): Promise<SaveOutcome>;
}

/**
 * Pure CAS resolution shared by every backend: given what is stored and what
 * a tab wants to save, decide the outcome. Exercised directly by tests.
 */
export function resolveSave(
  stored: { readonly revision: number } | null,
  expectedRevision: number,
): { readonly proceed: true } | { readonly proceed: false; readonly currentRevision: number } {
  if (stored === null) {
    return expectedRevision === 0 ? { proceed: true } : { proceed: false, currentRevision: 0 };
  }
  return stored.revision === expectedRevision
    ? { proceed: true }
    : { proceed: false, currentRevision: stored.revision };
}

/** Validate a stored record back into a StudioDraft (fail closed on any drift). */
export function recordToDraft(record: unknown): LoadOutcome {
  if (typeof record !== 'object' || record === null) {
    return { ok: false, kind: 'invalid', message: 'the stored draft record is malformed' };
  }
  const source = record as Record<string, unknown>;
  if (source['schemaVersion'] !== STUDIO_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: 'invalid',
      message: `the stored draft was written by a different Studio version (${String(source['schemaVersion'])}) — start from the compiled baseline or clear the local draft`,
    };
  }
  if (typeof source['draftId'] !== 'string' || source['draftId'].length === 0) {
    return { ok: false, kind: 'invalid', message: 'the stored draft id is malformed' };
  }
  if (
    typeof source['revision'] !== 'number' ||
    !Number.isInteger(source['revision']) ||
    source['revision'] < 0
  ) {
    return { ok: false, kind: 'invalid', message: 'the stored draft revision is malformed' };
  }
  if (typeof source['savedAt'] !== 'string' || source['savedAt'].length === 0) {
    return { ok: false, kind: 'invalid', message: 'the stored draft timestamp is malformed' };
  }
  const proposal = parseMomentProposal(source['proposal']);
  if (!proposal.ok) {
    return {
      ok: false,
      kind: 'invalid',
      message: `the stored draft's proposal no longer satisfies the contract (${proposal.errors[0]?.fieldPath ?? '(root)'}: ${proposal.errors[0]?.message ?? 'unknown'}) — start from the compiled baseline`,
    };
  }
  return {
    ok: true,
    savedAt: source['savedAt'],
    draft: {
      schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
      draftId: source['draftId'],
      revision: source['revision'],
      proposal: proposal.data,
    },
  };
}

/** Validate the draft BEFORE it reaches storage (the same fail-closed law). */
export function buildRecord(draft: StudioDraft, nextRevision: number): StoredDraftRecord {
  const proposal = parseMomentProposal(draft.proposal);
  if (!proposal.ok) {
    throw new Error(
      `studio draft failed its own proposal schema before save (${proposal.errors[0]?.fieldPath ?? '(root)'}: ${proposal.errors[0]?.message ?? 'unknown'})`,
    );
  }
  return {
    schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
    draftId: draft.draftId,
    revision: nextRevision,
    savedAt: new Date().toISOString(),
    proposal: proposal.data,
  };
}
