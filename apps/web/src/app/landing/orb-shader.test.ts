import { describe, expect, it } from 'vitest';
import { OrbDriver, ORB_FRAGMENT, ORB_VERTEX, ORB_PALETTE } from './orb-shader';

/**
 * KYN-09 — the adapted orb driver: the upstream spring math re-expressed as
 * a pure class. Pins the intro reveal, the FSM dissolve ramp (the orb swells
 * and fades exactly like the upstream intro played backwards) and pointer
 * responsiveness — all without a GPU.
 */

const SETTINGS = {
  size: 1,
  speed: 1,
  hoverIntensity: 1,
  motion: 1,
  sizePulse: 0,
};
const VIEW = { width: 1000, height: 800 };

function stepSeconds(
  driver: OrbDriver,
  seconds: number,
  pointer = { x: 500, y: 400, inside: true },
): void {
  const steps = Math.ceil(seconds / 0.016);
  for (let i = 0; i < steps; i += 1) driver.update(0.016, SETTINGS, pointer, VIEW);
}

describe('OrbDriver (adapted React Bits Orb driver)', () => {
  it('intro reveal ramps 0 → 1 and settles', () => {
    const driver = new OrbDriver(true);
    expect(driver.debugState().reveal).toBeLessThan(0.1);
    stepSeconds(driver, 2.5);
    expect(driver.debugState().reveal).toBeCloseTo(1, 2);
  });

  it('dissolve drives reveal down (the orb fades out under the fragments)', () => {
    const driver = new OrbDriver(false);
    stepSeconds(driver, 0.5);
    driver.setDissolve(0.5);
    stepSeconds(driver, 0.2);
    expect(driver.debugState().reveal).toBeLessThanOrEqual(0.5 + 1e-6);
    driver.setDissolve(1);
    stepSeconds(driver, 0.2);
    expect(driver.debugState().reveal).toBeCloseTo(0, 2);
  });

  it('pointer proximity wakes the orb (hover spring rises)', () => {
    const far = new OrbDriver(false);
    stepSeconds(far, 0.5, { x: 9990, y: 9990, inside: true });
    const near = new OrbDriver(false);
    stepSeconds(near, 0.5, { x: 500, y: 400, inside: true }); // orb center
    expect(near.debugState().hover).toBeGreaterThan(far.debugState().hover);
  });

  it('exposes every uniform the shader declares (source/port integrity)', () => {
    const driver = new OrbDriver(false);
    stepSeconds(driver, 0.1);
    const values = driver.uniforms({
      size: 1,
      glow: 1.35,
      bleed: 1.1,
      wobble: 0.9,
      highlight: 0.9,
      trail: 0.85,
      hoverIntensity: 0.55,
      opacity: 1,
    });
    const uniformNames = new Set(Object.keys(values));
    const shaderUniforms = [...ORB_FRAGMENT.matchAll(/uniform\s+\w+\s+(u\w+)/g)].map((m) => m[1]!);
    // Every uniform the DRIVER sets must exist in the shader source, and the
    // shader's non-palette uniforms must all be driven (uResolution, palette
    // vectors, uTilt and static look uniforms are set by the component).
    for (const name of uniformNames) {
      expect(shaderUniforms).toContain(name);
    }
    for (const name of [
      'uTime',
      'uReveal',
      'uScale',
      'uSwirl',
      'uOrbit',
      'uReach',
      'uNear',
      'uAwake',
    ]) {
      expect(uniformNames.has(name)).toBe(true);
    }
  });

  it('the shader ports keep the upstream uniform set and Kyneloom palette', () => {
    expect(ORB_FRAGMENT).toContain('snoise3');
    expect(ORB_FRAGMENT).toContain('uCenter'); // documented adaptation
    expect(ORB_VERTEX).not.toContain('#version');
    expect(ORB_FRAGMENT).not.toContain('#version');
    expect(ORB_PALETTE.color1).toBe('#51D7BD');
    expect(ORB_PALETTE.background).toBe('#071319');
  });
});
