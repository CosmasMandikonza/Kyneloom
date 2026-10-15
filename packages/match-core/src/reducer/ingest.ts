import {
  canonicalJsonStringify,
  parseMatchEvent,
  parseTrackingSample,
  type MatchEvent,
  type TrackingSample,
} from '@kyneloom/contracts';

/**
 * Authoritative stream ingestion (KYN-04).
 *
 * SUPERSESSION POLICY (the decision requested by Issue #4):
 * An event's identity is (providerId, eventId). Within an identity, the
 * envelope with the HIGHEST sourceRevision supersedes all lower revisions —
 * history is retained, never mutated. `correctionOf` may reference:
 *   - the SAME eventId at a lower revision: a revision bump of one logical
 *     event (exactly what the simulator's `lateCorrection()` emits). This is
 *     NOT a circular correction; no distinct revision-specific envelope id
 *     is required.
 *   - a DIFFERENT eventId: that id must be known in the stream, otherwise
 *     the envelope is quarantined (unknown-correction-target).
 * A correction whose `correctionOf` revision chain points forward (target
 * revision >= its own) is quarantined (invalid-revision).
 *
 * ORDER INDEPENDENCE: acceptance is resolved per identity over the whole
 * batch (deterministic canonical-payload tie-break for conflicting
 * duplicates), so array order never changes the projection. LATENESS is
 * evaluated against each envelope's OWN `sequence` field (the generator's
 * emission order), not array position: a non-correction event is late when
 * its `occurredAtMs` trails the max `occurredAtMs` of all lower-sequence
 * events by more than the lateness window. Corrections are exempt —
 * corrections are accepted at any delay, as docs/04 requires.
 */

export type QuarantineReason =
  | 'malformed'
  | 'match-mismatch'
  | 'duplicate-conflict'
  | 'invalid-revision'
  | 'unknown-correction-target'
  | 'late'
  | 'tracking-duplicate-conflict';

export interface QuarantinedItem {
  readonly index: number;
  readonly kind: 'event' | 'tracking';
  readonly reason: QuarantineReason;
  readonly message: string;
}

export interface StreamIngestOptions {
  /** Non-correction events later than this window (by sequence) are quarantined. */
  readonly latenessWindowMs?: number;
}

export interface IngestedStream {
  /** Surviving events in canonical order: (occurredAtMs, providerId, eventId, sourceRevision). */
  readonly acceptedEvents: readonly MatchEvent[];
  /** Every accepted-identity envelope INCLUDING superseded revisions — the
   *  original source history stays inspectable; corrections never mutate it. */
  readonly allEventRevisions: readonly MatchEvent[];
  /** Deduplicated tracking in canonical order: (sampleTimeMs, entityId). */
  readonly acceptedTracking: readonly TrackingSample[];
  readonly quarantine: readonly QuarantinedItem[];
  /** Count of exact-duplicate envelopes/samples that were idempotently ignored. */
  readonly duplicateCount: number;
}

interface EventCandidate {
  index: number;
  event: MatchEvent;
  canonical: string;
  quarantined: boolean;
}

export function ingestMatchStream(
  input: {
    readonly matchId: string;
    readonly events: readonly unknown[];
    readonly tracking: readonly unknown[];
  },
  options: StreamIngestOptions = {},
): IngestedStream {
  const latenessWindowMs = options.latenessWindowMs ?? 30_000;
  const quarantine: QuarantinedItem[] = [];

  // ---- events: parse + match filter ----
  const candidates: EventCandidate[] = [];
  for (const [index, raw] of input.events.entries()) {
    const parsed = parseMatchEvent(raw);
    if (!parsed.ok) {
      quarantine.push({
        index,
        kind: 'event',
        reason: 'malformed',
        message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
      });
      continue;
    }
    if (parsed.data.matchId !== input.matchId) {
      quarantine.push({
        index,
        kind: 'event',
        reason: 'match-mismatch',
        message: `event matchId "${parsed.data.matchId}" does not belong to match "${input.matchId}" (cross-match/provider contamination)`,
      });
      continue;
    }
    candidates.push({
      index,
      event: parsed.data,
      canonical: canonicalJsonStringify(parsed.data),
      quarantined: false,
    });
  }

  // ---- lateness (by `sequence`, order-independent) ----
  const sortedBySequence = [...candidates].sort((a, b) => a.event.sequence - b.event.sequence);
  let watermarkMs = Number.NEGATIVE_INFINITY;
  for (const candidate of sortedBySequence) {
    const isCorrection = candidate.event.correctionOf !== null;
    if (!isCorrection && candidate.event.occurredAtMs < watermarkMs - latenessWindowMs) {
      candidate.quarantined = true;
      quarantine.push({
        index: candidate.index,
        kind: 'event',
        reason: 'late',
        message: `occurredAtMs ${String(candidate.event.occurredAtMs)} trails the sequence watermark ${String(watermarkMs)} by more than the ${String(latenessWindowMs)} ms lateness window`,
      });
      continue;
    }
    watermarkMs = Math.max(watermarkMs, candidate.event.occurredAtMs);
  }
  const alive = candidates.filter((c) => !c.quarantined);

  // ---- identity resolution: (providerId, eventId) → highest revision ----
  const byIdentity = new Map<string, EventCandidate[]>();
  for (const candidate of alive) {
    const key = `${candidate.event.providerId}|${candidate.event.eventId}`;
    const list = byIdentity.get(key) ?? [];
    list.push(candidate);
    byIdentity.set(key, list);
  }

  let duplicateCount = 0;
  const effective: EventCandidate[] = [];
  const allEventRevisions: MatchEvent[] = [];
  for (const list of byIdentity.values()) {
    // Exact duplicates (same revision + identical payload) collapse; the
    // canonical-payload tie-break keeps conflict resolution order-independent.
    const byRevision = new Map<number, EventCandidate[]>();
    for (const candidate of list) {
      const group = byRevision.get(candidate.event.sourceRevision) ?? [];
      group.push(candidate);
      byRevision.set(candidate.event.sourceRevision, group);
    }
    const resolvedPerRevision: EventCandidate[] = [];
    for (const [revision, group] of byRevision) {
      void revision;
      const distinct = new Map<string, EventCandidate>();
      for (const candidate of group) {
        const existing = distinct.get(candidate.canonical);
        if (existing === undefined) {
          distinct.set(candidate.canonical, candidate);
        } else {
          duplicateCount += 1; // exact duplicate envelope, idempotently ignored
        }
      }
      if (distinct.size === 1) {
        resolvedPerRevision.push(distinct.values().next().value!);
        continue;
      }
      // Conflicting payloads for one (identity, revision): keep the
      // lexicographically smallest canonical payload (deterministic), and
      // quarantine every conflicting sibling.
      const ranked = [...distinct.values()].sort((a, b) => (a.canonical < b.canonical ? -1 : 1));
      resolvedPerRevision.push(ranked[0]!);
      for (const loser of ranked.slice(1)) {
        quarantine.push({
          index: loser.index,
          kind: 'event',
          reason: 'duplicate-conflict',
          message: `conflicting payload for ${loser.event.providerId}/${loser.event.eventId} revision ${String(loser.event.sourceRevision)}; deterministic canonical tie-break kept a different payload`,
        });
      }
    }
    resolvedPerRevision.sort((a, b) => a.event.sourceRevision - b.event.sourceRevision);
    const winner = resolvedPerRevision[resolvedPerRevision.length - 1]!;
    effective.push(winner);
    for (const superseded of resolvedPerRevision.slice(0, -1)) {
      allEventRevisions.push(superseded.event); // history: superseded, still inspectable
    }
  }

  // ---- correction-chain validation on the effective set ----
  const knownIds = new Set(effective.map((c) => c.event.eventId));
  const knownRevisions = new Map<string, number>();
  for (const c of effective) {
    knownRevisions.set(
      c.event.eventId,
      Math.max(knownRevisions.get(c.event.eventId) ?? 0, c.event.sourceRevision),
    );
  }
  const validated: MatchEvent[] = [];
  for (const candidate of effective) {
    allEventRevisions.push(candidate.event);
    const correctionOf = candidate.event.correctionOf;
    if (correctionOf === null) {
      validated.push(candidate.event);
      continue;
    }
    if (correctionOf === candidate.event.eventId) {
      // Self-reference = revision bump of the same logical event (documented
      // supersession policy). A forward-pointing bump is invalid.
      if (candidate.event.sourceRevision <= 1) {
        quarantine.push({
          index: candidate.index,
          kind: 'event',
          reason: 'invalid-revision',
          message: `revision ${String(candidate.event.sourceRevision)} cannot correct itself; revision 1 has nothing to supersede`,
        });
        continue;
      }
      validated.push(candidate.event);
      continue;
    }
    if (!knownIds.has(correctionOf)) {
      quarantine.push({
        index: candidate.index,
        kind: 'event',
        reason: 'unknown-correction-target',
        message: `correctionOf "${correctionOf}" references an event id that never appears in this stream`,
      });
      continue;
    }
    if (candidate.event.sourceRevision <= (knownRevisions.get(correctionOf) ?? 0)) {
      quarantine.push({
        index: candidate.index,
        kind: 'event',
        reason: 'invalid-revision',
        message: `correction revision ${String(candidate.event.sourceRevision)} does not supersede target "${correctionOf}" (target revision ${String(knownRevisions.get(correctionOf) ?? 0)})`,
      });
      continue;
    }
    validated.push(candidate.event);
  }

  // ---- tracking: parse + match filter + duplicate policy ----
  const trackingByPair = new Map<string, { sample: TrackingSample; canonical: string }>();
  for (const [index, raw] of input.tracking.entries()) {
    const parsed = parseTrackingSample(raw);
    if (!parsed.ok) {
      quarantine.push({
        index,
        kind: 'tracking',
        reason: 'malformed',
        message: parsed.errors.map((e) => `${e.fieldPath}: ${e.message}`).join('; '),
      });
      continue;
    }
    const sample = parsed.data;
    if (sample.matchId !== input.matchId) {
      quarantine.push({
        index,
        kind: 'tracking',
        reason: 'match-mismatch',
        message: `sample matchId "${sample.matchId}" does not belong to match "${input.matchId}"`,
      });
      continue;
    }
    const key = `${sample.sampleTimeMs}|${sample.entityId}`;
    const canonical = canonicalJsonStringify(sample);
    const existing = trackingByPair.get(key);
    if (existing === undefined) {
      trackingByPair.set(key, { sample, canonical });
    } else if (existing.canonical === canonical) {
      duplicateCount += 1;
    } else {
      // A conflicting duplicate sample can never become a verified spatial
      // fact: both payloads are quarantined and the pair is absent.
      trackingByPair.delete(key);
      quarantine.push({
        index,
        kind: 'tracking',
        reason: 'tracking-duplicate-conflict',
        message: `conflicting payloads for ${sample.entityId} at ${String(sample.sampleTimeMs)} ms; both rejected, the position is explicitly absent`,
      });
    }
  }
  const acceptedTracking = [...trackingByPair.values()]
    .map((v) => v.sample)
    .sort((a, b) => a.sampleTimeMs - b.sampleTimeMs || (a.entityId < b.entityId ? -1 : 1));

  const sortCanonically = (a: MatchEvent, b: MatchEvent): number =>
    a.occurredAtMs - b.occurredAtMs ||
    (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) ||
    a.sourceRevision - b.sourceRevision;
  validated.sort(sortCanonically);
  allEventRevisions.sort(sortCanonically);

  return {
    acceptedEvents: validated,
    allEventRevisions,
    acceptedTracking,
    quarantine,
    duplicateCount,
  };
}
