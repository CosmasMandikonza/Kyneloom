import { describe, expect, it } from 'vitest';
import { parseManifestCameras, type ThreeCameraTrack } from '@kyneloom/scene-renderer';
import invisibleAssistManifest from './directed/invisible-assist.manifest.json';
import { isUsableTrack, sampleCameraTrack, toAbsoluteTrack } from './camera-track';

/**
 * KYN-07 acceptance: manifest-directed camera playback. The clock law
 * (offsets → absolute match ms, converted exactly once), deterministic
 * sampling that lands exactly on authored keyframes, rejection of invalid
 * tracks/manifests, and the real authored Invisible Assist sequence
 * validated through the canonical contract.
 */

const WINDOW_START = 4_717_000;

function parsedTrack(): ThreeCameraTrack {
  const parsed = parseManifestCameras(invisibleAssistManifest);
  if (!parsed.ok) throw new Error('authored manifest must parse: ' + JSON.stringify(parsed.errors));
  const track = parsed.tracks[0]!;
  if (!isUsableTrack(track)) throw new Error('authored track must be usable');
  return track;
}

describe('authored Invisible Assist manifest (canonical contract)', () => {
  it('validates through parseManifestCameras as a single directed track', () => {
    const parsed = parseManifestCameras(invisibleAssistManifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.timeRangeMs).toEqual([4_717_000, 4_731_000]);
    expect(parsed.tracks).toHaveLength(1);
    expect(parsed.tracks[0]!.mode).toBe('directed');
    expect(parsed.tracks[0]!.keyframes.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps every authored camera above the pitch and inside fov bounds', () => {
    for (const kf of parsedTrack().keyframes) {
      // pitchToThree puts height on component 1.
      expect(kf.position[1]).toBeGreaterThanOrEqual(0.5);
      expect(kf.target[1]).toBeGreaterThanOrEqual(0);
      expect(kf.fovDeg).toBeGreaterThanOrEqual(20);
      expect(kf.fovDeg).toBeLessThanOrEqual(120);
    }
  });

  it('converts the offset clock to absolute match ms exactly once', () => {
    const track = toAbsoluteTrack(parsedTrack(), WINDOW_START);
    expect(track.startAbsMs).toBe(4_717_000);
    expect(track.endAbsMs).toBe(4_731_000); // window start + 14_000 offset
    expect(track.keyframes[0]!.absMs).toBe(4_717_000);
    // Offsets 4000 and 11300 (the goal beat) map to absolute match times.
    expect(track.keyframes[1]!.absMs).toBe(4_721_000);
    expect(track.keyframes[6]!.absMs).toBe(4_728_300);
  });
});

describe('sampleCameraTrack determinism', () => {
  it('returns the authored pose EXACTLY at keyframe times', () => {
    const track = toAbsoluteTrack(parsedTrack(), WINDOW_START);
    const goalKf = track.keyframes[6]!; // t=4728300 — the goal beat
    const pose = sampleCameraTrack(track, goalKf.absMs);
    expect(pose.position.distanceTo(goalKf.position)).toBeLessThan(1e-9);
    expect(pose.target.distanceTo(goalKf.target)).toBeLessThan(1e-9);
    expect(pose.fovDeg).toBe(goalKf.fovDeg);
  });

  it('is a pure function of the playhead — repeated/out-of-order queries agree', () => {
    const track = toAbsoluteTrack(parsedTrack(), WINDOW_START);
    const a = sampleCameraTrack(track, 4_725_000);
    sampleCameraTrack(track, 4_718_000);
    sampleCameraTrack(track, 4_730_000);
    const b = sampleCameraTrack(track, 4_725_000);
    expect(b.position.distanceTo(a.position)).toBeLessThan(1e-12);
    expect(b.fovDeg).toBeCloseTo(a.fovDeg, 12);
  });

  it('holds the nearest end pose outside the track interval — no extrapolation', () => {
    const track = toAbsoluteTrack(parsedTrack(), WINDOW_START);
    const before = sampleCameraTrack(track, 4_700_000);
    expect(before.position.distanceTo(track.keyframes[0]!.position)).toBeLessThan(1e-9);
    const after = sampleCameraTrack(track, 4_740_000);
    const last = track.keyframes[track.keyframes.length - 1]!;
    expect(after.position.distanceTo(last.position)).toBeLessThan(1e-9);
  });

  it('moves monotonically between adjacent keyframes (no oscillation)', () => {
    const track = toAbsoluteTrack(parsedTrack(), WINDOW_START);
    const a = track.keyframes[3]!;
    const b = track.keyframes[4]!;
    let previous = -Infinity;
    for (let i = 0; i <= 10; i += 1) {
      const t = a.absMs + ((b.absMs - a.absMs) * i) / 10;
      const pose = sampleCameraTrack(track, t);
      const along = pose.position.distanceTo(a.position); // distance from segment start
      expect(along).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = along;
    }
  });
});

describe('isUsableTrack rejects corrupt payloads', () => {
  const base = (): ThreeCameraTrack => ({
    id: 'cam-test',
    mode: 'directed',
    startMs: 0,
    endMs: 1000,
    keyframes: [
      { tMs: 0, position: [0, 5, 10], target: [0, 0, 0], fovDeg: 46 },
      { tMs: 1000, position: [10, 5, 0], target: [5, 0, 0], fovDeg: 42 },
    ],
  });

  it('accepts the minimal valid track', () => {
    expect(isUsableTrack(base())).toBe(true);
  });

  // Mutations deliberately corrupt the readonly payload; run them through a
  // writable deep clone (as if hand-edited data reached the rig).
  // Fully mutable structural alias (the payload type is deep-readonly).
  type MutableTrack = {
    id: string;
    mode: string;
    startMs: number;
    endMs: number;
    keyframes: { tMs: number; position: number[]; target: number[]; fovDeg: number }[];
  };
  const rejections: readonly [name: string, mutate: (t: MutableTrack) => void][] = [
    ['single keyframe', (t) => void t.keyframes.pop()],
    ['non-increasing keyframe times', (t) => void (t.keyframes[1]!.tMs = 0)],
    ['non-finite position', (t) => void (t.keyframes[0]!.position = [Number.NaN, 5, 10])],
    ['fov below the contract floor', (t) => void (t.keyframes[0]!.fovDeg = 10)],
    ['fov above the contract ceiling', (t) => void (t.keyframes[0]!.fovDeg = 130)],
    ['camera below the 0.5 m height floor', (t) => void (t.keyframes[0]!.position = [0, 0.2, 10])],
    ['target underground', (t) => void (t.keyframes[0]!.target = [0, -1, 0])],
  ];

  for (const [name, mutate] of rejections) {
    it(`rejects: ${name}`, () => {
      const track = JSON.parse(JSON.stringify(base())) as unknown as MutableTrack;
      mutate(track);
      expect(isUsableTrack(track as unknown as ThreeCameraTrack)).toBe(false);
    });
  }
});

describe('invalid manifests are rejected by the contract seam', () => {
  const corrupted = (mutate: (m: Record<string, unknown>) => void): unknown => {
    const clone = JSON.parse(JSON.stringify(invisibleAssistManifest)) as Record<string, unknown>;
    mutate(clone);
    return clone;
  };

  it('rejects a camera placed underground (z below the contract floor)', () => {
    const input = corrupted((m) => {
      const scene = m.scene as { cameraTracks: { keyframes: { position: number[] }[] }[] };
      scene.cameraTracks[0]!.keyframes[0]!.position = [26, -34, 0.2];
    });
    const parsed = parseManifestCameras(input);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a fov outside 20–120°', () => {
    const input = corrupted((m) => {
      const scene = m.scene as { cameraTracks: { keyframes: { fovDeg: number }[] }[] };
      scene.cameraTracks[0]!.keyframes[0]!.fovDeg = 12;
    });
    const parsed = parseManifestCameras(input);
    expect(parsed.ok).toBe(false);
  });

  it('rejects absolute-times masquerading as offsets (clock-law violation)', () => {
    const input = corrupted((m) => {
      const scene = m.scene as { cameraTracks: { keyframes: { tMs: number }[] }[] };
      scene.cameraTracks[0]!.keyframes[1]!.tMs = 4_731_000; // way past the window
    });
    const parsed = parseManifestCameras(input);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a single-keyframe track', () => {
    const input = corrupted((m) => {
      const scene = m.scene as { cameraTracks: { keyframes: unknown[] }[] };
      scene.cameraTracks[0]!.keyframes = [scene.cameraTracks[0]!.keyframes[0]];
    });
    const parsed = parseManifestCameras(input);
    expect(parsed.ok).toBe(false);
  });
});
