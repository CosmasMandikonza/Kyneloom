/**
 * Shared second-order spring integrator (KYN-10 tilt, KYN-11 dock).
 *
 * Mechanics adapted from React Bits `TiltedCard` at commit
 * `310fc737fadcaa149a4e06fb088fc95332dc8bfb` (MIT + Commons Clause v1.0,
 * Copyright 2026 David Haz — notice preserved; application use permitted,
 * the components themselves not redistributable). Fixed 1/240 s
 * sub-stepping makes the step frame-rate independent; the boolean return
 * is the caller's "still moving" signal for settle-aware loop gating.
 */

export interface Spring {
  value: number;
  velocity: number;
}

/**
 * Advance one spring toward its target by dt seconds. Returns true while
 * the spring is still meaningfully moving — the caller's keep-the-loop
 * -alive signal.
 */
export function stepSpring(
  spring: Spring,
  target: number,
  omega: number,
  zeta: number,
  dt: number,
): boolean {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let index = 0; index < steps; index += 1) {
    spring.velocity +=
      (omega * omega * (target - spring.value) - 2 * zeta * omega * spring.velocity) * h;
    spring.value += spring.velocity * h;
  }
  const settled = Math.abs(target - spring.value) < 0.001 && Math.abs(spring.velocity) < 0.01;
  if (settled) {
    spring.value = target;
    spring.velocity = 0;
  }
  return !settled;
}
