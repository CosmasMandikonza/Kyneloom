import type { MatchEvent, MomentManifest } from '@kyneloom/contracts';
import type { VerifiedMetric } from './compile';

/**
 * Broadcast-overlay + recap derivation (KYN-16, issue #31): the SAME
 * compiled manifest drives the immersive 3D scene, an allowlisted
 * time-coded overlay surface, and a typed caption/recap — with one match
 * clock and one set of evidence ids across all three.
 *
 * Every cue is DERIVED from manifest content that has already passed
 * semantic verification: overlay kinds, verified metric values, verified
 * claims, accepted source events. No new prose is invented here — text is
 * either a claim's own words, a formatted verified number, or a source
 * event's kind/actor. Cue times are ABSOLUTE match milliseconds (the same
 * axis as the replay playhead), so consumers never convert clocks.
 */

export interface BroadcastCue {
  readonly id: string;
  readonly kind: 'metric' | 'caption' | 'event_marker';
  /** Absolute match-relative ms [start, end) — same axis as the playhead. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Evidence entries backing every word of this cue. */
  readonly evidenceIds: readonly string[];
  /** The verified metric a metric cue renders, by manifest alias. */
  readonly metricAlias?: string;
}

export interface RecapLine {
  readonly claimId: string;
  readonly text: string;
  readonly status: 'observed' | 'calculated' | 'hypothesis';
  readonly evidenceIds: readonly string[];
  readonly inferenceDisclosure?: string;
}

export interface CompiledPresentation {
  readonly broadcast: readonly BroadcastCue[];
  readonly recap: {
    readonly headline: string;
    readonly lines: readonly RecapLine[];
  };
}

function fmt3(value: number): string {
  return value.toFixed(3);
}

function fmt2(value: number): string {
  return value.toFixed(2);
}

function formatMetricValue(metric: VerifiedMetric): string {
  const value = metric.value;
  switch (metric.kind) {
    case 'separation-delta': {
      const before = value['beforeM'];
      const after = value['afterM'];
      const delta = value['deltaM'];
      if (typeof before === 'number' && typeof after === 'number' && typeof delta === 'number') {
        return `SEPARATION ${fmt3(before)} m → ${fmt3(after)} m · Δ ${fmt3(delta)} m — measured`;
      }
      break;
    }
    case 'nearest-opponent': {
      const distance = value['distanceM'];
      const opponent = value['entityId'];
      if (typeof distance === 'number' && typeof opponent === 'string') {
        return `NEAREST OPPONENT ${fmt3(distance)} m — ${opponent}`;
      }
      break;
    }
    case 'passing-lane-occupancy': {
      const occupants = value['occupants'];
      const length = value['corridorLengthM'];
      if (Array.isArray(occupants) && typeof length === 'number') {
        return `PASSING LANE · ${String(occupants.length)} in corridor · ${fmt3(length)} m`;
      }
      break;
    }
    case 'off-ball-movement': {
      const mean = value['meanSpeedMps'];
      const peak = value['maxSpeedMps'];
      if (typeof mean === 'number' && typeof peak === 'number') {
        return `MOVEMENT · mean ${fmt2(mean)} m/s · peak ${fmt2(peak)} m/s`;
      }
      break;
    }
  }
  return `${metric.kind.toUpperCase()} · ${JSON.stringify(value)}`;
}

function formatEventCue(event: MatchEvent): string {
  const actor = event.actorId === null ? '' : ` — ${event.actorId}`;
  return `${event.kind.replace(/_/g, ' ').toUpperCase()}${actor}`;
}

export function derivePresentation(
  manifest: MomentManifest,
  metrics: readonly VerifiedMetric[],
  recapHeadline: string,
  events: readonly MatchEvent[],
): CompiledPresentation {
  const momentStartMs = manifest.timeRangeMs[0];
  const metricsByEvidenceId = new Map(metrics.map((metric) => [metric.evidenceId, metric]));
  const aliases = new Set(metrics.map((metric) => metric.alias));

  const broadcast: BroadcastCue[] = [];
  for (const overlay of manifest.scene.overlays) {
    const startMs = momentStartMs + overlay.startMs;
    const endMs = momentStartMs + overlay.endMs;

    // Metric cue: an explicitly referenced metric, or the verified metric a
    // cited derived_metric evidence entry computed.
    const alias =
      overlay.metricRef !== undefined && aliases.has(overlay.metricRef)
        ? overlay.metricRef
        : (overlay.evidenceIds
            .map((id) => metricsByEvidenceId.get(id))
            .find((metric) => metric !== undefined)?.alias ?? null);
    if (alias !== null) {
      const metric = metrics.find((entry) => entry.alias === alias);
      if (metric !== undefined) {
        broadcast.push({
          id: overlay.id,
          kind: 'metric',
          startMs,
          endMs,
          text: formatMetricValue(metric),
          evidenceIds: [...overlay.evidenceIds],
          metricAlias: alias,
        });
        continue;
      }
    }

    // Event cue: a cited source_event evidence entry names a real event.
    const eventEntry = manifest.evidence.find(
      (entry) => entry.kind === 'source_event' && overlay.evidenceIds.includes(entry.id),
    );
    if (eventEntry !== undefined) {
      const event = events.find((candidate) => candidate.eventId === eventEntry.ref);
      if (event !== undefined) {
        broadcast.push({
          id: overlay.id,
          kind: 'event_marker',
          startMs,
          endMs,
          text: formatEventCue(event),
          evidenceIds: [...overlay.evidenceIds],
        });
        continue;
      }
    }

    // Caption cue: the caption shows a VERIFIED claim's own words — the
    // first claim sharing evidence with the overlay. An editorial caption
    // with no claim carries no typed text and renders no cue (nothing is
    // invented here).
    const claim = manifest.claims.find((c) =>
      c.evidenceIds.some((id) => overlay.evidenceIds.includes(id)),
    );
    if (claim !== undefined) {
      broadcast.push({
        id: overlay.id,
        kind: 'caption',
        startMs,
        endMs,
        text: claim.text,
        evidenceIds: [...overlay.evidenceIds],
      });
    }
  }

  broadcast.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));

  return {
    broadcast,
    recap: {
      headline: recapHeadline,
      lines: manifest.claims.map((claim) => ({
        claimId: claim.id,
        text: claim.text,
        status: claim.status,
        evidenceIds: [...claim.evidenceIds],
        ...(claim.inferenceDisclosure === undefined
          ? {}
          : { inferenceDisclosure: claim.inferenceDisclosure }),
      })),
    },
  };
}
