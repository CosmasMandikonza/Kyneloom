import type { Claim, ManifestPresentation, MatchEvent, VisualOverlay } from '@kyneloom/contracts';
import { eventCueText, metricCueText } from './facts';
import type { VerifiedMetric } from './compile';

/**
 * Presentation assembly (KYN-16, review blockers B and final-1).
 *
 * The broadcast cues and recap the audience sees are BUILT INTO the
 * manifest's content-addressed `presentation` section (one hash covers
 * every visible word), and every cue's CONTENT comes from a compile-verified
 * overlay binding — this module performs NO resolution of its own. A metric
 * cue cites exactly the evidence that computes the displayed value; an
 * event cue cites exactly the cited source event; a caption carries a
 * verified hypothesis claim's editorial text and cites the CLAIM's own
 * evidence. False provenance is structurally impossible here because the
 * compiler rejects unsupported bindings before this code runs.
 *
 * Cue times are OFFSETS from the moment start (the manifest clock law);
 * consumers convert to the absolute match clock exactly once.
 */

/** The compile-verified channel behind one overlay. */
export type OverlayBinding =
  | {
      readonly overlay: VisualOverlay;
      readonly channel: { readonly kind: 'metric'; readonly evidenceId: string };
    }
  | {
      readonly overlay: VisualOverlay;
      readonly channel: { readonly kind: 'event'; readonly evidenceId: string };
    }
  | {
      readonly overlay: VisualOverlay;
      readonly channel: { readonly kind: 'caption'; readonly claimId: string };
    };

export function buildManifestPresentation(input: {
  readonly claims: readonly Claim[];
  readonly bindings: readonly OverlayBinding[];
  readonly metricsByEvidenceId: ReadonlyMap<string, VerifiedMetric>;
  readonly eventsByEvidenceId: ReadonlyMap<string, MatchEvent>;
  readonly headline: string;
}): ManifestPresentation {
  const broadcast = input.bindings.map((binding): ManifestPresentation['broadcast'][number] => {
    const overlay = binding.overlay;
    const channel = binding.channel;
    if (channel.kind === 'metric') {
      const metric = input.metricsByEvidenceId.get(channel.evidenceId);
      if (metric === undefined) {
        throw new Error('presentation binding references an unverified metric');
      }
      return {
        id: overlay.id,
        kind: 'metric' as const,
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        text: metricCueText(metric),
        // Exactly the evidence that computes the displayed number.
        evidenceIds: [metric.evidenceId],
        metricAlias: metric.alias,
      };
    }
    if (channel.kind === 'event') {
      const event = input.eventsByEvidenceId.get(channel.evidenceId);
      if (event === undefined) {
        throw new Error('presentation binding references an unaccepted event');
      }
      return {
        id: overlay.id,
        kind: 'event_marker' as const,
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        text: eventCueText(event),
        // Exactly the cited source event.
        evidenceIds: [channel.evidenceId],
      };
    }
    const claim = input.claims.find((candidate) => candidate.id === channel.claimId);
    if (claim === undefined) {
      throw new Error('presentation binding references an unknown claim');
    }
    return {
      id: overlay.id,
      kind: 'caption' as const,
      startMs: overlay.startMs,
      endMs: overlay.endMs,
      text: claim.text,
      // The editorial claim's own support — the caption displays its words.
      evidenceIds: [...claim.evidenceIds],
    };
  });

  broadcast.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));

  return {
    presentationVersion: 'kyneloom-presentation-v1',
    broadcast,
    recap: {
      headline: input.headline,
      lines: input.claims.map((claim) => ({
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
