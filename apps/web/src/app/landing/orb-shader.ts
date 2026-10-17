/**
 * KYN-09 — the landing orb, adapted from React Bits "Orb".
 *
 * UPSTREAM SOURCE (inspected and pinned):
 *   https://github.com/DavidHDev/react-bits/blob/482ab1cd3f567467a8dc9f49683bcefe54223e2c/src/ts-tailwind/Backgrounds/Orb/Orb.tsx
 *   commit 482ab1cd3f567467a8dc9f49683bcefe54223e2c (2026-10-11)
 *   Copyright (c) 2026 David Haz — MIT + Commons Clause License v1.0.
 *   Application use is permitted; the components themselves may not be
 *   sold/sublicensed/redistributed. Notice preserved here per the license.
 *
 * WHAT WAS ADAPTED (and why):
 * - The upstream component owns a raw WebGL2 context. KYN-09 runs the orb,
 *   the fragment field and the pitch reveal in ONE R3F/Three canvas (docs/17
 *   §3 warns about two simultaneous WebGL contexts), so the GLSL3 fragment
 *   shader is ported verbatim into a ShaderMaterial fullscreen triangle
 *   (`#version`/`precision` lines removed — Three injects them).
 * - The upstream per-frame JS driver (time/swirl/orbit/reach springs/pulse/
 *   reveal) is re-expressed as the pure `OrbDriver` class below so it can be
 *   driven by the landing transition FSM, unit-tested, and given a
 *   DISSOLVE ramp (reveal 1→0 = the orb swells and fades exactly like the
 *   upstream intro, played backwards) at the FRAGMENTS state.
 * - Palette is Kyneloom's: mint over ink-950, restrained glow.
 *   The orb is the prelude, never the transition itself (Issue #9).
 */

export const ORB_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;

export const ORB_FRAGMENT = /* glsl */ `
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform float uTime;
uniform float uRotation;
uniform vec2 uReach;
uniform float uNear;
uniform float uAwake;
uniform vec3 uBackground;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform float uScale;
uniform float uWobble;
uniform float uGlow;
uniform float uBleed;
uniform float uHighlight;
uniform float uSwirl;
uniform float uOrbit;
uniform vec2 uEcho;
uniform float uReveal;
uniform float uOpacity;
uniform float uTrail;
uniform vec2 uTilt;
out vec4 outColor;

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yxz + 19.19);
  return -1.0 + 2.0 * fract(vec3(p3.x + p3.y, p3.x + p3.z, p3.y + p3.z) * p3.zyx);
}

float snoise3(vec3 p) {
  const float K1 = 0.333333333;
  const float K2 = 0.166666667;
  vec3 i = floor(p + (p.x + p.y + p.z) * K1);
  vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
  vec3 e = step(vec3(0.0), d0 - d0.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 d1 = d0 - (i1 - K2);
  vec3 d2 = d0 - (i2 - K1);
  vec3 d3 = d0 - 0.5;
  vec4 h = max(0.6 - vec4(dot(d0, d0), dot(d1, d1), dot(d2, d2), dot(d3, d3)), 0.0);
  vec4 n = h * h * h * h * vec4(dot(d0, hash33(i)), dot(d1, hash33(i + i1)), dot(d2, hash33(i + i2)), dot(d3, hash33(i + 1.0)));
  return dot(vec4(31.316), n);
}

float light1(float intensity, float attenuation, float dist) {
  return intensity / (1.0 + dist * attenuation);
}

float light2(float intensity, float attenuation, float dist) {
  return intensity / (1.0 + dist * dist * attenuation);
}

vec4 draw(vec2 uv) {
  float rawLen = length(uv);
  vec2 dir = rawLen > 0.0001 ? uv / rawLen : vec2(1.0, 0.0);
  float reachAmount = length(uReach);
  vec2 reachDir = reachAmount > 0.00001 ? uReach / reachAmount : vec2(1.0, 0.0);
  float facing = exp((dot(dir, reachDir) - 1.0) * 3.2);
  float len = max(rawLen - reachAmount * facing * smoothstep(0.25, 0.65, rawLen), 0.0);
  uv = dir * len;
  float ang = atan(dir.y, dir.x);
  float invLen = len > 0.0 ? 1.0 / len : 0.0;
  float near = facing * uNear;
  float bgLuminance = dot(uBackground, vec3(0.299, 0.587, 0.114));

  float n0 = snoise3(vec3(uv * 0.65, uTime * 0.5)) * 0.5 + 0.5;
  float r0 = mix(0.8 - 0.04 * uWobble, 0.8 + 0.04 * uWobble, n0);
  float d0 = distance(uv, (r0 * invLen) * uv);
  float v0 = light1(1.0, 10.0 / uGlow, d0);
  v0 *= smoothstep(r0 * 1.05, r0, len);
  float reach = max(uBleed, 0.04);
  float innerFade = smoothstep(r0 * (1.0 - 0.2 * reach), r0 * (1.0 - 0.05 * reach), len);
  v0 *= mix(innerFade, 1.0, bgLuminance * 0.7 * min(uBleed, 1.0));
  float body = smoothstep(0.8 - 0.2 * reach, 0.8, len);
  float cl = cos(ang + uSwirl) * 0.5 + 0.5;

  vec2 pos = vec2(cos(uOrbit), sin(uOrbit)) * r0;
  float d = distance(uv, pos);
  vec2 head = vec2(cos(uOrbit), sin(uOrbit));
  float lag = atan(head.x * dir.y - head.y * dir.x, dot(dir, head));
  float trail = uTrail > 0.0 ? smoothstep(0.0, 0.35, lag) * exp(-max(lag, 0.0) * 2.6 / uTrail) : 0.0;
  float v1 = (light2(1.5, 5.0, d) + trail * 0.6) * uHighlight;
  v1 *= light1(1.0, 50.0, d0);
  float band = v0 * smoothstep(1.0, mix(0.6, 1.0, n0 * 0.5), len) * body;
  float heat = pow(clamp(band / 0.82, 0.0, 1.0), 3.0);
  float bloom = light2(1.0, 160.0 / uGlow, max(len - r0, 0.0)) * smoothstep(0.4, 0.0, len - r0) * step(r0, len);

  float v2 = smoothstep(1.0, mix(0.6, 1.0, n0 * 0.5), len);
  float v3 = body;

  vec3 colBase = mix(uColor1, uColor2, cl);
  float fadeAmount = mix(1.0, 0.1, bgLuminance);

  float echoD = abs(len - r0 - uEcho.x);
  float echo = light1(1.0, 60.0, echoD) * smoothstep(0.12, 0.0, echoD) * uEcho.y;

  vec3 darkCol = mix(uColor3, colBase, v0);
  darkCol = (darkCol + v1) * v2 * v3 * (1.0 + uAwake + near * 0.35) + mix(colBase, vec3(1.0), 0.25) * heat * (0.28 + near * 0.3);
  darkCol = clamp(darkCol + colBase * (bloom * 0.1 + echo), 0.0, 1.0);

  vec3 lightCol = (colBase + v1) * mix(1.0, v2 * v3, fadeAmount);
  lightCol = mix(uBackground, lightCol, clamp(v0 + echo, 0.0, 1.0));
  lightCol = mix(lightCol, colBase, clamp(v0, 0.0, 1.0) * clamp(near * 0.4 + uAwake, 0.0, 0.6));
  lightCol = clamp(mix(lightCol, vec3(1.0), clamp(v1 * 0.35, 0.0, 0.6)), 0.0, 1.0);

  vec3 finalCol = mix(darkCol, lightCol, bgLuminance);
  float alpha = max(max(finalCol.r, finalCol.g), finalCol.b);
  return vec4(finalCol / (alpha + 1e-5), alpha);
}

vec2 toPlane(vec2 p, out float hit) {
  float cx = cos(uTilt.x);
  float sx = sin(uTilt.x);
  float cy = cos(uTilt.y);
  float sy = sin(uTilt.y);
  vec3 ex = vec3(cy, 0.0, -sy);
  vec3 ey = vec3(sy * sx, cx, cy * sx);
  vec3 normal = vec3(sy * cx, -sx, cy * cx);
  vec3 origin = vec3(0.0, 0.0, 3.2);
  vec3 ray = vec3(p, -3.2);
  float denom = dot(normal, ray);
  float t = -dot(normal, origin) / (abs(denom) > 0.00001 ? denom : -0.00001);
  hit = t > 0.0 ? 1.0 : 0.0;
  vec3 q = origin + ray * t;
  return vec2(dot(q, ex), dot(q, ey));
}

void main() {
  // uCenter (adaptation): the orb's screen anchor in [0,1] — lets the
  // composition place the orb off-center (right on desktop, upper on mobile)
  // without moving the camera. Upstream was hard-centered at 0.5.
  vec2 uv = (gl_FragCoord.xy - uResolution * uCenter) / min(uResolution.x, uResolution.y) * 2.0;
  uv *= uScale;
  float hit = 1.0;
  if (abs(uTilt.x) + abs(uTilt.y) > 0.0001) uv = toPlane(uv, hit);

  float s = sin(uRotation);
  float c = cos(uRotation);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

  vec4 col = draw(uv);
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  float alpha = clamp(col.a * hit * uReveal * uOpacity + dither, 0.0, 1.0);
  outColor = vec4(col.rgb * alpha * alpha, alpha);
}
`;

/** Kyneloom palette for the orb (brand mint over cinematic ink). */
export const ORB_PALETTE = {
  color1: '#51D7BD',
  color2: '#1E7A67',
  color3: '#0B2830',
  background: '#071319',
} as const;

const INTRO_SECONDS = 1.1;
const FOCAL = 3.2;

const clamp01 = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));

/**
 * The upstream per-frame driver state, re-expressed as a pure class so the
 * landing FSM can own pacing (idle → intro → dissolve) and tests can pin
 * the springs. `update()` mirrors the upstream frame() math exactly.
 */
export class OrbDriver {
  private time = 0;
  private swirl = 0;
  private orbit = 0;
  private echo = 1;
  private rotation = 0;
  private hover = 0;
  private near = 0;
  private reachX = 0;
  private reachY = 0;
  private reachSpeedX = 0;
  private reachSpeedY = 0;
  private pulse = 0;
  private pulseSpeed = 0;
  private kick: number;
  private reveal: number;
  private dissolveT = 0;

  constructor(intro: boolean) {
    this.kick = intro ? 2.5 : 0;
    this.reveal = intro ? 0 : 1;
  }

  /** 0→1 ramp played at FRAGMENTS start: the orb swells and fades away. */
  setDissolve(t: number): void {
    this.dissolveT = clamp01(t);
  }
  getDissolve(): number {
    return this.dissolveT;
  }

  /**
   * @param pointerPx pointer in canvas CSS px; `inside` false when off-canvas.
   * @param viewPx canvas CSS size (for the orb-space transform).
   */
  update(
    dtSeconds: number,
    settings: {
      size: number;
      speed: number;
      hoverIntensity: number;
      motion: number; // 0 for reduced-motion (still time + render, no swirl)
      sizePulse: number;
    },
    pointer: { x: number; y: number; inside: boolean },
    viewPx: { width: number; height: number },
    center: { x: number; y: number } = { x: 0.5, y: 0.5 },
  ): void {
    const dt = clamp01(dtSeconds, 0.0005, 0.05);
    const s = settings;
    const motion = s.motion;

    // Pointer → orb-space (upstream toOrb, rotation/tilt kept at 0). The
    // anchor matches uCenter so hover/reach tracks the composed orb.
    const side = Math.max(1, Math.min(viewPx.width, viewPx.height));
    const scale = 1 / (s.size * (1 + this.pulse));
    const px = ((pointer.x - viewPx.width * center.x) / side) * 2 * scale;
    const py = ((viewPx.height * center.y - pointer.y) / side) * 2 * scale;

    const distance = Math.hypot(px, py);
    const region = pointer.inside && motion > 0 ? clamp01((1.45 - distance) / 0.4) : 0;
    const zone = region * region * (3 - 2 * region);
    const aimed = zone * clamp01((distance - 0.15) / 0.45);

    this.hover += (zone - this.hover) * (1 - Math.exp(-dt / 0.16));
    const reach = 0.075 * s.hoverIntensity * aimed;
    const goalX = distance > 0.0001 ? (px / distance) * reach : 0;
    const goalY = distance > 0.0001 ? (py / distance) * reach : 0;
    this.reachSpeedX += (70 * (goalX - this.reachX) - 7 * this.reachSpeedX) * dt;
    this.reachSpeedY += (70 * (goalY - this.reachY) - 7 * this.reachSpeedY) * dt;
    this.reachX += this.reachSpeedX * dt;
    this.reachY += this.reachSpeedY * dt;
    this.near += (aimed * s.hoverIntensity - this.near) * (1 - Math.exp(-dt / 0.12));

    const step = dt * s.speed * motion;
    this.time += step;
    this.swirl += step * 2 * (1 + this.kick);
    this.echo = Math.min(1, this.echo + dt / 1.2);

    // The orbiting highlight chases the cursor gently.
    const aim = Math.atan2(py, px);
    if (pointer.inside && zone > 0.5 && motion > 0) {
      const delta = Math.atan2(Math.sin(aim - this.orbit), Math.cos(aim - this.orbit));
      this.orbit += delta * (1 - Math.exp(-dt * 6));
    } else {
      this.orbit -= step;
    }
    this.orbit = Math.atan2(Math.sin(this.orbit), Math.cos(this.orbit));

    this.pulseSpeed += (-170 * this.pulse - 11 * this.pulseSpeed) * dt;
    this.pulse += this.pulseSpeed * dt + s.sizePulse * dt;
    this.kick *= Math.exp(-dt * 2.5);

    // Intro reveal plays once; the FSM dissolve then runs it backwards with
    // the upstream swell (grow formula), fading the orb as fragments erupt.
    if (this.reveal < 1) this.reveal = Math.min(1, this.reveal + dt / INTRO_SECONDS);
    const dissolveTarget = 1 - this.dissolveT * this.dissolveT * (3 - 2 * this.dissolveT);
    this.reveal = Math.min(this.reveal, Math.max(0, dissolveTarget));
  }

  /** Uniform values mirroring the upstream render() setters. */
  uniforms(settings: {
    size: number;
    glow: number;
    bleed: number;
    wobble: number;
    highlight: number;
    trail: number;
    hoverIntensity: number;
    opacity: number;
  }): Record<string, number | readonly number[]> {
    const reveal = this.reveal;
    const back = reveal - 1;
    const grow = 1 + 2.2 * back * back * back + 1.2 * back * back;
    const revealUniform =
      Math.min(1, reveal / 0.55) *
      Math.min(1, reveal / 0.55) *
      (3 - 2 * Math.min(1, reveal / 0.55));
    return {
      uTime: this.time,
      uRotation: this.rotation,
      uReach: [this.reachX, this.reachY],
      uNear: this.near,
      uAwake: this.hover * settings.hoverIntensity * 0.18,
      uScale: 1 / (settings.size * (1 + this.pulse) * (0.62 + 0.38 * grow)),
      uSwirl: this.swirl,
      uOrbit: this.orbit,
      uEcho: [this.echo * 0.55, this.echo < 1 ? (1 - this.echo) * (1 - this.echo) : 0],
      uReveal: revealUniform,
      uOpacity: settings.opacity,
    };
  }

  /** Exposed for tests: the spring states the upstream component held. */
  debugState(): { reveal: number; hover: number; orbit: number } {
    return { reveal: this.reveal, hover: this.hover, orbit: this.orbit };
  }
}

export const ORB_FOCAL = FOCAL;
