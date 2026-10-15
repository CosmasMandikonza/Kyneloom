import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { SeededRng } from './rng';

/**
 * Fault-injection variants (KYN-03 build scope). These are ADVERSARIAL
 * INPUTS for the future deterministic reducer (KYN-04) — stream-level
 * delivery faults that the reducer must survive. The golden fixture itself
 * is never mutated; variants are derived copies.
 *
 * Every variant is deterministic for a given seed.
 */

export interface VariantReport {
  readonly kind:
    | 'duplicate-events'
    | 'out-of-order-delivery'
    | 'late-correction'
    | 'dropped-frames'
    | 'ambiguous-identity';
  readonly description: string;
  readonly detail: Record<string, string | number>;
}

/** Duplicate a deterministic subset of event envelopes (at-least-once delivery). */
export function duplicateEvents(
  events: readonly MatchEvent[],
  seed: number,
  ratio = 0.15,
): { events: MatchEvent[]; report: VariantReport } {
  const rng = new SeededRng(seed);
  const out: MatchEvent[] = [];
  let duplicated = 0;
  for (const event of events) {
    out.push(event);
    if (rng.next() < ratio) {
      out.push(event);
      duplicated += 1;
    }
  }
  return {
    events: out,
    report: {
      kind: 'duplicate-events',
      description:
        'Some envelopes are delivered twice; the reducer must deduplicate by provider/eventId/revision.',
      detail: { duplicated, total: out.length },
    },
  };
}

/** Shuffle delivery order (arrival ≠ event time). Envelope contents untouched. */
export function reorderEvents(
  events: readonly MatchEvent[],
  seed: number,
): { events: MatchEvent[]; report: VariantReport } {
  const rng = new SeededRng(seed);
  const out = [...events];
  // Deterministic Fisher–Yates.
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return {
    events: out,
    report: {
      kind: 'out-of-order-delivery',
      description:
        'Envelopes arrive in a shuffled order; the reducer must project by event time with a lateness policy.',
      detail: { inversions: countInversionsByTime(out) },
    },
  };
}

function countInversionsByTime(events: readonly MatchEvent[]): number {
  let inversions = 0;
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (events[j]!.occurredAtMs < events[i]!.occurredAtMs) inversions += 1;
    }
  }
  return inversions;
}

/**
 * A late correction of the golden pass (evt-0042): sourceRevision 2
 * referencing the superseded envelope, with a refined position. Also
 * supports goal rescission via `asNoGoal`.
 */
export function lateCorrection(
  events: readonly MatchEvent[],
  options: { asNoGoal?: boolean } = {},
): { events: MatchEvent[]; report: VariantReport } {
  const target =
    events.find((e) => e.eventId === 'evt-0042') ?? events.find((e) => e.kind === 'pass_completed');
  const homeGoal = events.find((e) => e.kind === 'goal' && e.teamId === 'home');
  if (!target) throw new Error('no pass_completed event to correct');
  if (options.asNoGoal === true && !homeGoal) throw new Error('no home goal to rescind');
  const corrected: MatchEvent =
    options.asNoGoal === true
      ? {
          ...(homeGoal as MatchEvent),
          sourceRevision: 2,
          kind: 'offside_called',
          attributes: { corrected_outcome: 'no_goal', rescinds: 'goal' },
          correctionOf: (homeGoal as MatchEvent).eventId,
          sequence: events.length + 1,
        }
      : {
          ...target,
          position: { xM: target.position!.xM + 0.5, yM: target.position!.yM + 0.4 },
          sourceRevision: 2,
          correctionOf: target.eventId,
          sequence: events.length + 1,
        };
  return {
    events: [...events, corrected],
    report: {
      kind: 'late-correction',
      description: options.asNoGoal
        ? 'A correction rescinds the goal as offside; the reducer must recompute score and invalidate derived manifests.'
        : 'A correction refines the golden pass position at sourceRevision 2; the reducer must supersede, not duplicate.',
      detail: { corrects: corrected.correctionOf ?? '', newRevision: 2 },
    },
  };
}

/**
 * Drop tracking frames (stream disconnect): the affected times have NO
 * samples at all — absence stays explicit, nothing is filled or fabricated.
 */
export function dropFrames(
  tracking: readonly TrackingSample[],
  seed: number,
  ratio = 0.08,
): { tracking: TrackingSample[]; report: VariantReport } {
  const rng = new SeededRng(seed);
  const frameTimes = [...new Set(tracking.map((s) => s.sampleTimeMs))].sort((a, b) => a - b);
  const droppedTimes = new Set(frameTimes.filter(() => rng.next() < ratio));
  const out = tracking.filter((s) => !droppedTimes.has(s.sampleTimeMs));
  return {
    tracking: out,
    report: {
      kind: 'dropped-frames',
      description:
        'Whole frames are missing (disconnect); consumers must treat gaps as absent data, never interpolate silently across them without disclosure.',
      detail: { droppedFrames: droppedTimes.size, remaining: out.length },
    },
  };
}

/**
 * Identity ambiguity: within a window, two players' samples swap entity ids.
 * Every sample remains contract-valid; only physical plausibility reveals
 * the corruption — exactly the ambiguity KYN-04 must detect.
 */
export function ambiguousIdentities(
  tracking: readonly TrackingSample[],
  options: { a: string; b: string; fromMs: number; toMs: number },
): { tracking: TrackingSample[]; report: VariantReport } {
  const out = tracking.map((sample) => {
    if (sample.sampleTimeMs < options.fromMs || sample.sampleTimeMs > options.toMs) return sample;
    if (sample.entityId === options.a) return { ...sample, entityId: options.b };
    if (sample.entityId === options.b) return { ...sample, entityId: options.a };
    return sample;
  });
  return {
    tracking: out,
    report: {
      kind: 'ambiguous-identity',
      description:
        'Two players swap ids inside a window; envelope-valid but physically implausible — identity resolution must flag it.',
      detail: { a: options.a, b: options.b, fromMs: options.fromMs, toMs: options.toMs },
    },
  };
}
