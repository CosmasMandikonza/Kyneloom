import { parseMatchEvent, type MatchEvent } from '@kyneloom/contracts';
import { isInsidePitch, type PitchDimensions, type PitchPoint } from './pitch';

/**
 * Contract consumption seam for the future simulator/reducer (KYN-03/KYN-04):
 * backend code parses canonical envelopes and immediately applies canonical
 * pitch geometry — one shared notion of coordinates, no reinterpretation.
 */

export type EventGeometryResult =
  | {
      readonly ok: true;
      readonly event: MatchEvent;
      readonly position: PitchPoint | null;
      readonly withinPitch: boolean | null;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<{ readonly fieldPath: string; readonly message: string }>;
    };

/**
 * Validate an incoming envelope against the canonical contract, then locate
 * its position relative to the pitch. Events without a position report
 * `withinPitch: null` — absence is explicit, never assumed in-bounds.
 */
export function locateEvent(
  input: unknown,
  pitch: PitchDimensions,
  options: { marginM?: number } = {},
): EventGeometryResult {
  const parsed = parseMatchEvent(input);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors.map((error) => ({
        fieldPath: error.fieldPath,
        message: error.message,
      })),
    };
  }
  const event = parsed.data;
  if (!event.position) {
    return { ok: true, event, position: null, withinPitch: null };
  }
  const position = { xM: event.position.xM, yM: event.position.yM };
  return { ok: true, event, position, withinPitch: isInsidePitch(position, pitch, options) };
}
