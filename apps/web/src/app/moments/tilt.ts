/**
import { stepSpring } from '@/lib/spring';

export { stepSpring };
 * KYN-10 card tilt controller — bounded, spring-smoothed pointer depth.
 *
 * Mechanics ADAPTED (not copied) from React Bits `TiltedCard` at commit
 * `310fc737fadcaa149a4e06fb088fc95332dc8bfb`
 * (https://github.com/DavidHDev/react-bits/blob/310fc737fadcaa149a4e06fb088fc95332dc8bfb/src/ts-tailwind/Components/TiltedCard/TiltedCard.tsx),
 * MIT + Commons Clause v1.0, Copyright (c) 2026 David Haz. Application use
 * is permitted; the components themselves may not be redistributed — the
 * notice here preserves attribution for the adapted mechanics. What we kept:
 * the second-order spring integrator with fixed sub-stepping, the
 * settle-aware `wake()` pattern (the rAF loop stops when every spring has
 * settled — no idle loops in a 12-card grid), pointer-relative rotation with
 * clamped amplitude, and direct style/custom-property writes so pointer
 * movement NEVER triggers React re-renders. What we changed: no flip/tooltip/
 * gyroscope/intro machinery, no window-global listeners (card-local only),
 * reduced motion disables the spatial animation entirely (not just shrinks
 * it), and visibility gating is the caller's responsibility.
 */

import { stepSpring } from '@/lib/spring';

// Re-exported for the existing tilt tests; the shared home is lib/spring.
export { stepSpring };
export interface TiltSettings {
  /** Maximum pointer-relative rotation in degrees (≥ 0). */
  readonly amplitudeDeg: number;
  /** Hover/focus lift scale target (≥ 1). */
  readonly liftScale: number;
  /** Spring angular frequency (rad/s domain) — higher = snappier. */
  readonly omega: number;
  /** Spring damping ratio 0..1 (≈0.7–1 for no overshoot wobble). */
  readonly zeta: number;
}

export const DEFAULT_TILT_SETTINGS: TiltSettings = {
  amplitudeDeg: 7,
  liftScale: 1.02,
  omega: 18,
  zeta: 0.9,
};

interface Spring {
  value: number;
  velocity: number;
}

export interface TiltController {
  /** Pointer position normalized to −1..1 relative to the card center. */
  pointer(nx: number, ny: number): void;
  /** Engagement (hover with mouse, or keyboard focus) drives the lift. */
  setEngaged(engaged: boolean): void;
  /** Visibility gate — offscreen cards relax to rest and stop animating. */
  setVisible(visible: boolean): void;
  /** True while this controller's rAF loop is alive (QA probe). */
  isLoopActive(): boolean;
  destroy(): void;
}

/**
 * Live registry of controllers with an active rAF loop. The gallery's QA
 * probe reads `activeLoops()` to prove no sustained animation after the
 * pointer leaves the grid.
 */
const activeLoopControllers = new Set<TiltController>();
export const tiltRegistry = {
  activeLoops: (): number => activeLoopControllers.size,
};

/**
 * Framework-free controller bound to one element. Writes only:
 *  - `element.style.transform` (rotateX/rotateY/scale)
 *  - the CSS custom properties `--tilt-gx/--tilt-gy` (glare origin, %)
 *  - `--tilt-lift` (0..1, drives reveal/edge-light styling)
 * `reducedMotion` disables all spatial writes — the card stays static and
 * fully usable.
 */
export function createTiltController(
  element: HTMLElement,
  settings: TiltSettings = DEFAULT_TILT_SETTINGS,
  reducedMotion = false,
): TiltController {
  const rx: Spring = { value: 0, velocity: 0 };
  const ry: Spring = { value: 0, velocity: 0 };
  const lift: Spring = { value: 0, velocity: 0 };
  const pointer = { nx: 0, ny: 0 };
  const state = { engaged: false, visible: true };
  let raf = 0;
  let last = 0;
  let destroyed = false;

  if (reducedMotion) {
    // Static presentation: identical DOM, zero animation, zero listeners.
    return {
      pointer: () => {},
      setEngaged: () => {},
      setVisible: () => {},
      isLoopActive: () => false,
      destroy: () => {},
    };
  }

  const writeStyles = (): void => {
    const scale = 1 + (settings.liftScale - 1) * lift.value;
    element.style.transform = `rotateX(${rx.value.toFixed(3)}deg) rotateY(${ry.value.toFixed(3)}deg) scale(${scale.toFixed(4)})`;
    const reach = Math.max(settings.amplitudeDeg, 1);
    element.style.setProperty('--tilt-gx', `${(50 + (ry.value / reach) * 42).toFixed(2)}%`);
    element.style.setProperty('--tilt-gy', `${(50 - (rx.value / reach) * 42).toFixed(2)}%`);
    element.style.setProperty('--tilt-lift', lift.value.toFixed(3));
    element.toggleAttribute('data-tilt-active', state.engaged || lift.value > 0.01);
  };

  const frame = (now: number): void => {
    raf = 0;
    if (destroyed) {
      activeLoopControllers.delete(controller);
      return;
    }
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    // Offscreen: relax to rest without following the pointer.
    const following = state.visible;
    const targetRx = following ? -pointer.ny * settings.amplitudeDeg : 0;
    const targetRy = following ? pointer.nx * settings.amplitudeDeg : 0;
    const targetLift = following && state.engaged ? 1 : 0;
    let busy = stepSpring(rx, targetRx, settings.omega, settings.zeta, dt);
    busy = stepSpring(ry, targetRy, settings.omega, settings.zeta, dt) || busy;
    busy =
      stepSpring(lift, targetLift, settings.omega * 0.9, Math.max(settings.zeta, 0.85), dt) || busy;
    writeStyles();
    if (busy) {
      raf = requestAnimationFrame(frame);
    } else {
      activeLoopControllers.delete(controller);
    }
  };

  const wake = (): void => {
    if (raf !== 0 || destroyed) return;
    last = performance.now();
    activeLoopControllers.add(controller);
    raf = requestAnimationFrame(frame);
  };

  const controller: TiltController = {
    pointer(nx, ny) {
      pointer.nx = Math.max(-1, Math.min(1, nx));
      pointer.ny = Math.max(-1, Math.min(1, ny));
      wake();
    },
    setEngaged(engaged) {
      if (engaged === state.engaged) return;
      state.engaged = engaged;
      wake();
    },
    setVisible(visible) {
      // No-op transitions never wake the loop: a freshly mounted, visible
      // card has resting springs and must not schedule a frame at all.
      if (visible === state.visible) return;
      state.visible = visible;
      wake();
    },
    isLoopActive: () => raf !== 0,
    destroy() {
      destroyed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      activeLoopControllers.delete(controller);
      element.style.transform = '';
      element.removeAttribute('data-tilt-active');
    },
  };
  return controller;
}
