import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PITCH_LENGTH_M,
  DEFAULT_PITCH_WIDTH_M,
  PITCH_COORDINATE_SYSTEM,
  createPitchDimensions,
  isInsidePitch,
} from './pitch';

describe('createPitchDimensions', () => {
  it('defaults to the documented synthetic pitch size', () => {
    expect(createPitchDimensions()).toEqual({
      coordinateSystem: PITCH_COORDINATE_SYSTEM,
      lengthM: DEFAULT_PITCH_LENGTH_M,
      widthM: DEFAULT_PITCH_WIDTH_M,
    });
    expect(DEFAULT_PITCH_LENGTH_M).toBe(105);
    expect(DEFAULT_PITCH_WIDTH_M).toBe(68);
  });

  it('accepts custom finite positive dimensions', () => {
    const pitch = createPitchDimensions({ lengthM: 100, widthM: 64 });
    expect(pitch.lengthM).toBe(100);
    expect(pitch.widthM).toBe(64);
  });

  it('rejects non-finite and non-positive sizes', () => {
    for (const bad of [
      { lengthM: 0 },
      { lengthM: -105 },
      { lengthM: Number.NaN },
      { lengthM: Number.POSITIVE_INFINITY },
      { widthM: 0 },
      { widthM: -68 },
      { widthM: Number.NaN },
    ]) {
      expect(() => createPitchDimensions(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe('isInsidePitch', () => {
  const pitch = createPitchDimensions();

  it('contains the center and in-bounds points', () => {
    expect(isInsidePitch({ xM: 0, yM: 0 }, pitch)).toBe(true);
    expect(isInsidePitch({ xM: 21.4, yM: -13.8 }, pitch)).toBe(true);
    expect(isInsidePitch({ xM: 52.5, yM: 34 }, pitch)).toBe(true); // exact corner
  });

  it('excludes points beyond the touchlines and goal lines', () => {
    expect(isInsidePitch({ xM: 53, yM: 0 }, pitch)).toBe(false);
    expect(isInsidePitch({ xM: 0, yM: 34.5 }, pitch)).toBe(false);
    expect(isInsidePitch({ xM: -60, yM: -40 }, pitch)).toBe(false);
  });

  it('honors a positive margin for legitimately out-of-line players', () => {
    expect(isInsidePitch({ xM: 52.9, yM: 0 }, pitch, { marginM: 1 })).toBe(true);
    expect(isInsidePitch({ xM: 53.6, yM: 0 }, pitch, { marginM: 1 })).toBe(false);
  });

  it('treats non-finite coordinates as outside instead of throwing', () => {
    expect(isInsidePitch({ xM: Number.NaN, yM: 0 }, pitch)).toBe(false);
    expect(isInsidePitch({ xM: 0, yM: Number.POSITIVE_INFINITY }, pitch)).toBe(false);
  });

  it('rejects invalid margins loudly', () => {
    expect(() => isInsidePitch({ xM: 0, yM: 0 }, pitch, { marginM: -1 })).toThrow(RangeError);
    expect(() => isInsidePitch({ xM: 0, yM: 0 }, pitch, { marginM: Number.NaN })).toThrow(
      RangeError,
    );
  });
});
