/**
 * Pure scene-surface geometry shared by the future renderer and the current
 * foundation shell. Derived from canonical pitch dimensions in match-core so
 * the placeholder stage and the eventual 3D canvas agree on pitch proportions
 * from a single source.
 */
import { createPitchDimensions, type PitchDimensions } from '@kyneloom/match-core';

/** Width-to-height aspect ratio of the playing surface as displayed. */
export function pitchAspectRatio(pitch: PitchDimensions = createPitchDimensions()): number {
  return pitch.lengthM / pitch.widthM;
}
