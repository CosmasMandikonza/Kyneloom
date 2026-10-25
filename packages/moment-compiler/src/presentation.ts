import type { Claim, ManifestPresentation, MatchEvent, VisualOverlay } from '@kyneloom/contracts';
import { eventCueText, metricCueText } from './facts';
import type { VerifiedMetric } from './compile';

/**
 * Presentation assembly (KYN-16, review blocker B): the broadcast cues and
 * recap the audience sees are BUILT INTO the manifest's content-addressed
 * `presentation` section, so the single approval hash covers every visible
 * word. Everything here is compiler-authored:
 *
 * - metric cues quote the verified metric (facts.ts);
 * - event cues quote the accepted source event;
 * - caption cues carry a HYPOTHESIS claim's editorial text — the one channel
 *   for model prose, number-free by schema and hashed here like everything
 *   else;
 * - recap lines mirror the compiled claims (generated fact sentences for
 *   observed/calculated, editorial text for hypotheses).
 *
 * Cue times are OFFSETS from the moment start (the manifest clock law);
 * consumers convert to the absolute match clock exactly once.
 */

export function buildManifestPresentation(input: {
  readonly claims: readonly Claim[];
  readonly overlays: readonly VisualOverlay[];
  readonly metrics: readonly VerifiedMetric[];
  readonly metricsByEvidenceId: ReadonlyMap<string, VerifiedMetric>;
  readonly eventsByEvidenceId: ReadonlyMap<string, MatchEvent>;
  readonly headline: string;
}): ManifestPresentation {
  const aliases = new Set(input.metrics.map((metric) => metric.alias));

  const broadcast = [];
  for (const overlay of input.overlays) {
    // Caption overlays are the editorial voice: a hypothesis claim sharing
    // evidence with the overlay. Its number-free text is hashed into the
    // artifact; a caption with no matching editorial claim renders no cue.
    if (overlay.kind === 'caption') {
      const hypothesis = input.claims.find(
        (claim) =>
          claim.status === 'hypothesis' &&
          claim.evidenceIds.some((id) => overlay.evidenceIds.includes(id)),
      );
      if (hypothesis !== undefined) {
        broadcast.push({
          id: overlay.id,
          kind: 'caption' as const,
          startMs: overlay.startMs,
          endMs: overlay.endMs,
          text: hypothesis.text,
          evidenceIds: [...overlay.evidenceIds],
        });
      }
      continue;
    }

    // Data overlays quote verified content: an explicitly referenced metric,
    // or the verified metric a cited derived_metric evidence entry computed.
    const alias =
      overlay.metricRef !== undefined && aliases.has(overlay.metricRef)
        ? overlay.metricRef
        : (overlay.evidenceIds
            .map((id) => input.metricsByEvidenceId.get(id))
            .find((metric) => metric !== undefined)?.alias ?? null);
    if (alias !== null) {
      const metric = input.metrics.find((entry) => entry.alias === alias);
      if (metric !== undefined) {
        broadcast.push({
          id: overlay.id,
          kind: 'metric' as const,
          startMs: overlay.startMs,
          endMs: overlay.endMs,
          text: metricCueText(metric),
          evidenceIds: [...overlay.evidenceIds],
          metricAlias: alias,
        });
        continue;
      }
    }

    // Event cue: a cited source_event evidence entry names a real event.
    const eventEntry = overlay.evidenceIds
      .map((id) => input.eventsByEvidenceId.get(id))
      .find((event) => event !== undefined);
    if (eventEntry !== undefined) {
      broadcast.push({
        id: overlay.id,
        kind: 'event_marker' as const,
        startMs: overlay.startMs,
        endMs: overlay.endMs,
        text: eventCueText(eventEntry),
        evidenceIds: [...overlay.evidenceIds],
      });
    }
  }

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
