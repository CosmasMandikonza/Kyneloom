import { describe, expect, it } from 'vitest';
import { createPitchDimensions } from '@kyneloom/match-core';
import { pitchAspectRatio } from './scene-surface';

describe('pitchAspectRatio', () => {
  it('derives the default ratio from canonical match-core dimensions', () => {
    expect(pitchAspectRatio()).toBeCloseTo(105 / 68, 12);
  });

  it('reflects custom dimensions', () => {
    expect(pitchAspectRatio(createPitchDimensions({ lengthM: 100, widthM: 50 }))).toBe(2);
  });
});
