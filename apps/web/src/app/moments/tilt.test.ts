// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTiltController, DEFAULT_TILT_SETTINGS, stepSpring } from './tilt';

/**
 * KYN-10 tilt mechanics (adapted from React Bits TiltedCard, pinned commit
 * 310fc73 — see tilt.ts header for license/attribution). The invariants that
 * matter for a 12-card gallery: springs settle (loops STOP), reduced motion
 * disables every spatial write, and cleanup restores the element.
 */

describe('stepSpring', () => {
  it('converges to the target and reports settled', () => {
    const spring = { value: 0, velocity: 0 };
    let busy = true;
    for (let i = 0; i < 600 && busy; i += 1) {
      busy = stepSpring(spring, 6, DEFAULT_TILT_SETTINGS.omega, DEFAULT_TILT_SETTINGS.zeta, 1 / 60);
    }
    expect(busy).toBe(false);
    expect(spring.value).toBeCloseTo(6, 2);
    expect(spring.velocity).toBe(0);
  });

  it('is frame-rate independent within tolerance', () => {
    const run = (dt: number): number => {
      const spring = { value: 0, velocity: 0 };
      let t = 0;
      while (t < 0.5) {
        stepSpring(spring, 6, DEFAULT_TILT_SETTINGS.omega, DEFAULT_TILT_SETTINGS.zeta, dt);
        t += dt;
      }
      return spring.value;
    };
    expect(run(1 / 60)).toBeCloseTo(run(1 / 30), 1);
  });
});

describe('createTiltController', () => {
  const makeElement = (): HTMLElement => document.createElement('div');

  it('reduced motion produces a static controller that never writes styles', () => {
    const element = makeElement();
    const controller = createTiltController(element, DEFAULT_TILT_SETTINGS, true);
    controller.pointer(1, -1);
    controller.setEngaged(true);
    controller.setVisible(false);
    expect(controller.isLoopActive()).toBe(false);
    expect(element.style.transform).toBe('');
    controller.destroy();
  });

  it('destroys cleanly: loop cancelled, inline transform removed', () => {
    const element = makeElement();
    const controller = createTiltController(element, DEFAULT_TILT_SETTINGS, false);
    controller.setEngaged(true);
    controller.destroy();
    expect(controller.isLoopActive()).toBe(false);
    expect(element.style.transform).toBe('');
    expect(element.hasAttribute('data-tilt-active')).toBe(false);
  });

  it('relaxes to rest when marked offscreen', async () => {
    const element = makeElement();
    const controller = createTiltController(element, DEFAULT_TILT_SETTINGS, false);
    controller.pointer(1, 1);
    controller.setEngaged(true);
    controller.setVisible(false);
    // Let the relax settle (jsdom rAF runs on a 16ms timer by default).
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(controller.isLoopActive()).toBe(false);
    expect(element.style.transform).toContain('rotateX(0.000deg)');
    expect(element.style.transform).toContain('scale(1.0000)');
    controller.destroy();
  });
});
