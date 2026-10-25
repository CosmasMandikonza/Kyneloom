import { formatBroadcastClock, type MatchEvent } from '@kyneloom/contracts';
import type { VerifiedMetric } from './compile';

/**
 * Deterministic fact sentences (KYN-16 review, blocker A).
 *
 * Verified-claim text is GENERATED here from the deterministic computation —
 * never proposed, never free text. The same formatter family produces the
 * claim sentence (long form) and the broadcast cue (short form), so a number
 * can appear in audience-facing text by exactly one route: this module, fed
 * by a verified metric or an accepted source event.
 *
 * Broadcast clock formatting comes from contracts (`formatBroadcastClock`)
 * — the same implementation the web clock uses — so manifest sentences and
 * on-screen clocks can never disagree.
 */

function fmt3(value: number): string {
  return value.toFixed(3);
}

function fmt2(value: number): string {
  return value.toFixed(2);
}

/** Human phrases for accepted event kinds (fallback: kind with spaces). */
const EVENT_PHRASES: Record<string, string> = {
  kickoff: 'kickoff',
  period_start: 'period start',
  period_end: 'period end',
  pass_attempted: 'pass attempt released',
  pass_completed: 'pass completed',
  shot_attempted: 'shot attempted',
  goal: 'goal scored',
  correction: 'source correction',
};

/** Long-form factual sentence for a verified metric (claim text). */
export function metricFactSentence(metric: VerifiedMetric): string {
  const window = metric.requested.windowMs;
  switch (metric.kind) {
    case 'separation-delta': {
      const before = metric.value['beforeM'];
      const after = metric.value['afterM'];
      const delta = metric.value['deltaM'];
      if (
        typeof before === 'number' &&
        typeof after === 'number' &&
        typeof delta === 'number' &&
        window !== undefined
      ) {
        const entities = metric.dependsOn.entityIds;
        return (
          `The measured separation between ${entities.join(' and ')} changed by ` +
          `${fmt3(delta)} m (from ${fmt3(before)} m to ${fmt3(after)} m) between ` +
          `${formatBroadcastClock(window[0])} and ${formatBroadcastClock(window[1])}.`
        );
      }
      break;
    }
    case 'nearest-opponent': {
      const distance = metric.value['distanceM'];
      const opponent = metric.value['entityId'];
      if (typeof distance === 'number' && typeof opponent === 'string') {
        const at = metric.requested.atMs;
        const when = at === undefined ? '' : ` at ${formatBroadcastClock(at)}`;
        return `The nearest opponent to ${metric.dependsOn.entityIds.join(', ')} was ${opponent} at ${fmt3(distance)} m${when}.`;
      }
      break;
    }
    case 'passing-lane-occupancy': {
      const occupants = metric.value['occupants'];
      const length = metric.value['corridorLengthM'];
      if (Array.isArray(occupants) && typeof length === 'number') {
        return `The measured passing lane held ${String(occupants.length)} opponent${occupants.length === 1 ? '' : 's'} across ${fmt3(length)} m.`;
      }
      break;
    }
    case 'off-ball-movement': {
      const mean = metric.value['meanSpeedMps'];
      const peak = metric.value['maxSpeedMps'];
      if (typeof mean === 'number' && typeof peak === 'number') {
        return `The measured movement reached a peak of ${fmt2(peak)} m/s (mean ${fmt2(mean)} m/s).`;
      }
      break;
    }
  }
  return `Verified ${metric.kind} measurement (${metric.metricId}); see evidence for the computed value.`;
}

/** Long-form factual sentence for an accepted source event (claim text). */
export function eventFactSentence(event: MatchEvent): string {
  const phrase = EVENT_PHRASES[event.kind] ?? event.kind.replace(/_/g, ' ');
  const actor = event.actorId === null ? '' : ` by ${event.actorId}`;
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}${actor} at ${formatBroadcastClock(event.occurredAtMs)} (${event.eventId}).`;
}

/** Short-form cue text for a verified metric (broadcast overlay). */
export function metricCueText(metric: VerifiedMetric): string {
  switch (metric.kind) {
    case 'separation-delta': {
      const before = metric.value['beforeM'];
      const after = metric.value['afterM'];
      const delta = metric.value['deltaM'];
      if (typeof before === 'number' && typeof after === 'number' && typeof delta === 'number') {
        return `SEPARATION ${fmt3(before)} m → ${fmt3(after)} m · Δ ${fmt3(delta)} m — measured`;
      }
      break;
    }
    case 'nearest-opponent': {
      const distance = metric.value['distanceM'];
      const opponent = metric.value['entityId'];
      if (typeof distance === 'number' && typeof opponent === 'string') {
        return `NEAREST OPPONENT ${fmt3(distance)} m — ${opponent}`;
      }
      break;
    }
    case 'passing-lane-occupancy': {
      const occupants = metric.value['occupants'];
      const length = metric.value['corridorLengthM'];
      if (Array.isArray(occupants) && typeof length === 'number') {
        return `PASSING LANE · ${String(occupants.length)} in corridor · ${fmt3(length)} m`;
      }
      break;
    }
    case 'off-ball-movement': {
      const mean = metric.value['meanSpeedMps'];
      const peak = metric.value['maxSpeedMps'];
      if (typeof mean === 'number' && typeof peak === 'number') {
        return `MOVEMENT · mean ${fmt2(mean)} m/s · peak ${fmt2(peak)} m/s`;
      }
      break;
    }
  }
  return `${metric.kind.toUpperCase()} · ${JSON.stringify(metric.value)}`;
}

/** Short-form cue text for an accepted source event (broadcast overlay). */
export function eventCueText(event: MatchEvent): string {
  const phrase = EVENT_PHRASES[event.kind] ?? event.kind.replace(/_/g, ' ');
  const actor = event.actorId === null ? '' : ` — ${event.actorId}`;
  return `${phrase.toUpperCase()}${actor}`;
}
