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
 * SUPERSESSION POLICY (review-hardened):
 * An event's identity is (providerId, eventId). Within an identity, revisions
 * are validated in ascending order and only VALID revisions are promoted —
 * if a higher revision is rejected (unknown target, forward-pointing chain),
 * the previously accepted valid revision REMAINS authoritative: an invalid
 * update can never erase an accepted fact. `correctionOf` referencing the
 * SAME eventId means a revision bump of one logical event (the simulator's
 * `lateCorrection` pattern; NOT circular). A cross-id `correctionOf` must
 * reference an event id present in the stream at a lower revision.
 *
 * CONFLICTING DUPLICATES: when one (identity, revision) carries multiple
 * distinct payloads, there is no basis to trust any of them — every payload
 * is quarantined and the revision is poisoned until a legitimately higher
 * revision resolves the identity. The same rule tombstones conflicting
 * tracking pairs permanently: no later third sample can resurrect the pair.
 *
 * ORDER INDEPENDENCE: acceptance is resolved per identity over the whole
 * batch (no arrival-order tie-breaks anywhere), so duplicate, reordered or
 * shuffled delivery produces the identical projection. LATENESS is keyed to
 * each envelope's own `sequence` field, not array position; corrections are
 * exempt at any delay.
 *
 * APPLICATION SEQUENCE (`allEventRevisions`): every VALID envelope — base
 * revisions and superseded corrections — sorted by
 * (sourceRevision, occurredAtMs, providerId, eventId). This is the reducer's
 * checkpoint timeline: revision N = state after applying the first N
 * envelopes, so historical as-of snapshots (score before/after a rescission)
 * are genuine.
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
  /** Final effective events (highest VALID revision per identity), canonical order. */
  readonly acceptedEvents: readonly MatchEvent[];
  /** Every VALID envelope in application order (superseded included) — the
   *  as-of checkpoint timeline and inspectable history. */
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

  // ---- identity resolution: (providerId, eventId) → revisions ----
  const byIdentity = new Map<string, EventCandidate[]>();
  for (const candidate of alive) {
    const key = `${candidate.event.providerId}|${candidate.event.eventId}`;
    const list = byIdentity.get(key) ?? [];
    list.push(candidate);
    byIdentity.set(key, list);
  }

  // Global id/revision knowledge for correction-target validation: every id
  // seen in the stream (any revision, even a conflicted one) counts as
  // "known"; cross-id corrections must beat the highest revision seen.
  const knownIds = new Set<string>();
  const knownRevisions = new Map<string, number>();
  const revisionGroupsByIdentity = new Map<
    string,
    Map<number, { distinct: Map<string, EventCandidate>; conflicted: boolean }>
  >();
  let duplicateCount = 0;
  for (const [key, list] of byIdentity.entries()) {
    const byRevision = new Map<
      number,
      { distinct: Map<string, EventCandidate>; conflicted: boolean }
    >();
    for (const candidate of list) {
      knownIds.add(candidate.event.eventId);
      knownRevisions.set(
        candidate.event.eventId,
        Math.max(knownRevisions.get(candidate.event.eventId) ?? 0, candidate.event.sourceRevision),
      );
      let group = byRevision.get(candidate.event.sourceRevision);
      if (group === undefined) {
        group = { distinct: new Map(), conflicted: false };
        byRevision.set(candidate.event.sourceRevision, group);
      }
      if (!group.distinct.has(candidate.canonical)) {
        group.distinct.set(candidate.canonical, candidate);
      } else {
        duplicateCount += 1; // exact duplicate envelope, idempotently ignored
      }
    }
    revisionGroupsByIdentity.set(key, byRevision);
  }

  // ---- per identity: validate revisions ascending; invalid never erases ----
  const effective: MatchEvent[] = [];
  const applicationOrder: MatchEvent[] = [];
  for (const byRevision of revisionGroupsByIdentity.values()) {
    const revisions = [...byRevision.entries()].sort((a, b) => a[0] - b[0]);
    let currentValid: MatchEvent | null = null;
    for (const [revision, group] of revisions) {
      if (group.conflicted || group.distinct.size > 1) {
        // Conflicting payloads for one (identity, revision): nothing here is
        // trustworthy. Quarantine every distinct payload; the revision is
        // skipped entirely (a higher valid revision may still resolve).
        for (const candidate of group.distinct.values()) {
          quarantine.push({
            index: candidate.index,
            kind: 'event',
            reason: 'duplicate-conflict',
            message: `conflicting payloads for ${candidate.event.providerId}/${candidate.event.eventId} revision ${String(revision)}; all payloads rejected — an authoritative revision is required to resolve this identity`,
          });
        }
        continue;
      }
      const candidate = group.distinct.values().next().value!;
      const problem = validateCorrection(candidate.event, knownIds, knownRevisions);
      if (problem === null) {
        // Valid: promote. A superseded valid revision stays in history.
        if (currentValid !== null) {
          applicationOrder.push(currentValid);
        }
        currentValid = candidate.event;
      } else {
        // Invalid higher revision: quarantined; the previously accepted
        // valid revision REMAINS authoritative (never erased).
        quarantine.push({
          index: candidate.index,
          kind: 'event',
          reason: problem.reason,
          message: problem.message,
        });
      }
    }
    if (currentValid !== null) {
      effective.push(currentValid);
      applicationOrder.push(currentValid);
    }
  }

  // ---- tracking: parse + match filter + tombstoned duplicate policy ----
  const trackingDistinct = new Map<
    string,
    Map<string, { sample: TrackingSample; index: number }>
  >();
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
    let group = trackingDistinct.get(key);
    if (group === undefined) {
      group = new Map();
      trackingDistinct.set(key, group);
    }
    const existing = group.get(canonical);
    if (existing === undefined) {
      group.set(canonical, { sample, index });
    } else {
      duplicateCount += 1;
    }
  }
  const acceptedTracking: TrackingSample[] = [];
  for (const [key, group] of trackingDistinct.entries()) {
    if (group.size === 1) {
      acceptedTracking.push(group.values().next().value!.sample);
      continue;
    }
    // Conflicting payloads for one (entity, time): tombstone the pair — no
    // payload becomes a verified spatial fact, and no later sample can
    // resurrect it (the tombstone is the pair state, order-independent).
    for (const { sample, index } of group.values()) {
      quarantine.push({
        index,
        kind: 'tracking',
        reason: 'tracking-duplicate-conflict',
        message: `conflicting payloads for ${sample.entityId} at ${String(sample.sampleTimeMs)} ms; all rejected and the pair tombstoned — the position is explicitly absent`,
      });
    }
    void key;
  }
  acceptedTracking.sort(
    (a, b) => a.sampleTimeMs - b.sampleTimeMs || (a.entityId < b.entityId ? -1 : 1),
  );

  const sortCanonically = (a: MatchEvent, b: MatchEvent): number =>
    a.occurredAtMs - b.occurredAtMs ||
    (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
    (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0) ||
    a.sourceRevision - b.sourceRevision;
  effective.sort(sortCanonically);
  // Application order: base revisions first, corrections strictly after the
  // revisions they supersede (sourceRevision major, then canonical order).
  applicationOrder.sort(
    (a, b) =>
      a.sourceRevision - b.sourceRevision ||
      a.occurredAtMs - b.occurredAtMs ||
      (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
  quarantine.sort((a, b) => a.index - b.index);

  return {
    acceptedEvents: effective,
    allEventRevisions: applicationOrder,
    acceptedTracking,
    quarantine,
    duplicateCount,
  };
}

function validateCorrection(
  event: MatchEvent,
  knownIds: Set<string>,
  knownRevisions: Map<string, number>,
): { reason: QuarantineReason; message: string } | null {
  const correctionOf = event.correctionOf;
  if (correctionOf === null) return null;
  if (correctionOf === event.eventId) {
    if (event.sourceRevision <= 1) {
      return {
        reason: 'invalid-revision',
        message: `revision ${String(event.sourceRevision)} cannot correct itself; revision 1 has nothing to supersede`,
      };
    }
    return null;
  }
  if (!knownIds.has(correctionOf)) {
    return {
      reason: 'unknown-correction-target',
      message: `correctionOf "${correctionOf}" references an event id that never appears in this stream`,
    };
  }
  if (event.sourceRevision <= (knownRevisions.get(correctionOf) ?? 0)) {
    return {
      reason: 'invalid-revision',
      message: `correction revision ${String(event.sourceRevision)} does not supersede target "${correctionOf}" (target revision ${String(knownRevisions.get(correctionOf) ?? 0)})`,
    };
  }
  return null;
}
