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
 * Concurrency identity — generation + revision, never revision alone:
 * a discard does NOT delete the concurrency history. It writes a durable
 * TOMBSTONE naming the discarded generation, and the next save starts a NEW
 * generation (previous + 1) at revision 1. Every save/reset compares the
 * caller's full expected token `{generation, revision}` against the stored
 * entry inside ONE atomic transaction. A stale tab holding an OLD
 * generation's token can therefore never CAS onto an unrelated new lineage
 * that happens to reuse the same revision number (the ABA race from review
 * 6429754954) — it receives an explicit conflict, and the new lineage's
 * data survives untouched.
 */

/** The typed compare-and-save token: lineage identity + revision within it. */
export interface DraftConcurrencyToken {
  /** Monotonic lineage number; increases across discard/recreate. */
  readonly generation: number;
  /** Revision within the generation; 0 means "nothing saved in this lineage yet". */
  readonly revision: number;
}

/** The persisted live record: schema-validated on write AND on load (fail closed). */
export interface StoredDraftRecord {
  readonly schemaVersion: typeof STUDIO_DRAFT_SCHEMA_VERSION;
  readonly draftId: string;
  readonly generation: number;
  readonly revision: number;
  readonly savedAt: string;
  readonly proposal: MomentProposal;
}

/**
 * The durable marker that a generation existed and was explicitly discarded.
 * Retained FOREVER (never the target of a bare delete) so a fresh lineage can
 * never reuse an older generation's identity — this is the ABA fix.
 */
export interface DraftTombstoneRecord {
  readonly schemaVersion: typeof STUDIO_DRAFT_SCHEMA_VERSION;
  readonly draftId: string;
  readonly generation: number;
  readonly discardedAt: string;
}

/** Anything the store may hold for a draftId. */
export type StoredDraftEntry = StoredDraftRecord | DraftTombstoneRecord;

export function isTombstone(entry: StoredDraftEntry): entry is DraftTombstoneRecord {
  return (entry as DraftTombstoneRecord).discardedAt !== undefined;
}

export type LoadOutcome =
  | {
      readonly ok: true;
      readonly kind: 'live';
      readonly draft: StudioDraft;
      readonly savedAt: string;
      readonly token: DraftConcurrencyToken;
    }
  | {
      /** Nothing live: the token a FRESH lineage in this store must present. */
      readonly ok: true;
      readonly kind: 'empty';
      readonly token: DraftConcurrencyToken;
    }
  | { readonly ok: false; readonly kind: 'invalid'; readonly message: string };

export type SaveOutcome =
  | { readonly ok: true; readonly token: DraftConcurrencyToken }
  | { readonly ok: false; readonly kind: 'conflict'; readonly current: DraftConcurrencyToken };

export type ResetOutcome =
  | { readonly ok: true; readonly nextToken: DraftConcurrencyToken }
  | { readonly ok: false; readonly kind: 'conflict'; readonly current: DraftConcurrencyToken }
  | { readonly ok: false; readonly kind: 'unavailable'; readonly message: string };

export interface StudioDraftRepository {
  /** The stored state for this id. A corrupt entry REJECTS (never coerced). */
  load(draftId: string): Promise<LoadOutcome>;
  /** Atomic compare-and-save over the full concurrency token. */
  save(draft: StudioDraft, expected: DraftConcurrencyToken): Promise<SaveOutcome>;
  /** Atomic compare-and-discard (explicit user action) — writes a tombstone. */
  reset(draftId: string, expected: DraftConcurrencyToken): Promise<ResetOutcome>;
}

const freshToken = (generation = 1): DraftConcurrencyToken => ({ generation, revision: 0 });

/**
 * Pure CAS resolution shared by every backend. Decides a save against what is
 * stored; exercised directly by tests. STRICT: only the exact expected token
 * proceeds — a stale generation OR a stale revision conflicts.
 */
export function resolveSave(
  stored: StoredDraftEntry | null,
  expected: DraftConcurrencyToken,
):
  | { readonly proceed: true; readonly token: DraftConcurrencyToken }
  | {
      readonly proceed: false;
      readonly current: DraftConcurrencyToken;
    } {
  if (stored === null) {
    return expected.revision === 0
      ? { proceed: true, token: { generation: expected.generation, revision: 1 } }
      : { proceed: false, current: freshToken() };
  }
  // Legacy v1 live records carry no generation — the first lineage (the
  // same normalization validateEntryShape applies on load).
  const storedGeneration = isTombstone(stored) ? stored.generation : (stored.generation ?? 1);
  if (isTombstone(stored)) {
    const next = freshToken(stored.generation + 1);
    return expected.generation === stored.generation + 1 && expected.revision === 0
      ? { proceed: true, token: { generation: next.generation, revision: 1 } }
      : { proceed: false, current: next };
  }
  return expected.generation === storedGeneration && expected.revision === stored.revision
    ? { proceed: true, token: { generation: storedGeneration, revision: stored.revision + 1 } }
    : { proceed: false, current: { generation: storedGeneration, revision: stored.revision } };
}

/**
 * Pure reset resolution: same strict law, applied to the discard. A live
 * record is discarded only with its exact token; a tombstone accepts only the
 * FOLLOW-UP lineage's fresh token (idempotent no-op); anything stale —
 * including an OLD generation's token after the lineage was recreated —
 * conflicts, and the stored data survives.
 */
export function resolveReset(
  stored: StoredDraftEntry | null,
  expected: DraftConcurrencyToken,
):
  | { readonly proceed: true; readonly tombstone: DraftTombstoneRecord | null }
  | {
      readonly proceed: false;
      readonly current: DraftConcurrencyToken;
    } {
  if (stored === null) {
    return expected.revision === 0
      ? { proceed: true, tombstone: null }
      : { proceed: false, current: freshToken() };
  }
  if (isTombstone(stored)) {
    const next = freshToken(stored.generation + 1);
    return expected.generation === stored.generation + 1 && expected.revision === 0
      ? { proceed: true, tombstone: null } // already discarded; nothing new to erase
      : { proceed: false, current: next };
  }
  const legacyGeneration = stored.generation ?? 1; // legacy v1 record
  if (expected.generation === legacyGeneration && expected.revision === stored.revision) {
    return {
      proceed: true,
      tombstone: {
        schemaVersion: stored.schemaVersion,
        draftId: stored.draftId,
        generation: legacyGeneration,
        discardedAt: new Date().toISOString(),
      },
    };
  }
  return {
    proceed: false,
    current: { generation: legacyGeneration, revision: stored.revision },
  };
}

/** Validate a stored LIVE record back into a StudioDraft (fail closed on drift). */
export function recordToDraft(record: StoredDraftRecord): LoadOutcome {
  const shape = validateEntryShape(record, record.draftId);
  if (!shape.ok) return shape;
  const proposal = parseMomentProposal(record.proposal);
  if (!proposal.ok) {
    return {
      ok: false,
      kind: 'invalid',
      message: `the stored draft's proposal no longer satisfies the contract (${proposal.errors[0]?.fieldPath ?? '(root)'}: ${proposal.errors[0]?.message ?? 'unknown'}) — start from the compiled baseline`,
    };
  }
  return {
    ok: true,
    kind: 'live',
    savedAt: record.savedAt,
    token: shape.token,
    draft: {
      schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
      draftId: record.draftId,
      revision: record.revision,
      proposal: proposal.data,
    },
  };
}

/**
 * Structural validation of a stored entry (live or tombstone). Legacy v1
 * records without a generation are read as generation 1 (their lineage IS
 * the first); a present-but-malformed generation fails closed.
 */
export function validateEntryShape(
  entry: StoredDraftEntry,
  expectedDraftId: string,
):
  | { readonly ok: true; readonly token: DraftConcurrencyToken }
  | {
      readonly ok: false;
      readonly kind: 'invalid';
      readonly message: string;
    } {
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, kind: 'invalid', message: 'the stored draft record is malformed' };
  }
  const source = entry as unknown as Record<string, unknown>;
  if (source['schemaVersion'] !== STUDIO_DRAFT_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: 'invalid',
      message: `the stored draft was written by a different Studio version (${String(source['schemaVersion'])}) — start from the compiled baseline or clear the local draft`,
    };
  }
  if (source['draftId'] !== expectedDraftId) {
    return { ok: false, kind: 'invalid', message: 'the stored draft id is malformed' };
  }
  const generation = source['generation'] ?? 1; // legacy v1 record → first lineage
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    return { ok: false, kind: 'invalid', message: 'the stored draft generation is malformed' };
  }
  if (isTombstone(entry)) {
    if (typeof source['discardedAt'] !== 'string' || source['discardedAt'].length === 0) {
      return { ok: false, kind: 'invalid', message: 'the stored tombstone is malformed' };
    }
    return { ok: true, token: freshToken(generation + 1) };
  }
  const revision = source['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, kind: 'invalid', message: 'the stored draft revision is malformed' };
  }
  if (typeof source['savedAt'] !== 'string' || source['savedAt'].length === 0) {
    return { ok: false, kind: 'invalid', message: 'the stored draft timestamp is malformed' };
  }
  return { ok: true, token: { generation, revision } };
}

/** Validate the draft BEFORE it reaches storage (the same fail-closed law). */
export function buildRecord(draft: StudioDraft, token: DraftConcurrencyToken): StoredDraftRecord {
  const proposal = parseMomentProposal(draft.proposal);
  if (!proposal.ok) {
    throw new Error(
      `studio draft failed its own proposal schema before save (${proposal.errors[0]?.fieldPath ?? '(root)'}: ${proposal.errors[0]?.message ?? 'unknown'})`,
    );
  }
  return {
    schemaVersion: STUDIO_DRAFT_SCHEMA_VERSION,
    draftId: draft.draftId,
    generation: token.generation,
    revision: token.revision,
    savedAt: new Date().toISOString(),
    proposal: proposal.data,
  };
}
