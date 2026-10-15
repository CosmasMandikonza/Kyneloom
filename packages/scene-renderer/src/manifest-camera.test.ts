import { describe, expect, it } from 'vitest';
import { cameraTrackToThree, parseManifestCameras } from './manifest-camera';
import { exampleMomentManifest, parseMomentManifest, type CameraTrack } from '@kyneloom/contracts';

const manifestFixture = exampleMomentManifest;

describe('cameraTrackToThree (frontend contract consumption)', () => {
  it('converts validated keyframes through the shared transform without touching time', () => {
    const manifest = parseMomentManifest(manifestFixture());
    if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));
    const track: CameraTrack = manifest.data.scene.cameraTracks[0]!;
    const three = cameraTrackToThree(track);

    expect(three.id).toBe('cam-01');
    expect(three.startMs).toBe(0);
    expect(three.endMs).toBe(14000);
    // docs/06-style keyframe [0, 46, 48] is pitch meters (z up):
    // three = (x, z, -y) = (0, 48, -46) — height lands on three.y.
    expect([...three.keyframes[0]!.position]).toEqual([0, 48, -46]);
    expect([...three.keyframes[0]!.target]).toEqual([0, 0, 0]);
    expect([...three.keyframes[1]!.position]).toEqual([12, 25, -35]);
    expect(three.keyframes[0]!.fovDeg).toBe(48);
    expect(three.keyframes[1]!.tMs).toBe(14000);
  });

  it('keeps camera height positive after conversion (y-up invariant)', () => {
    const manifest = parseMomentManifest(manifestFixture());
    if (!manifest.ok) throw new Error('fixture must parse');
    for (const track of manifest.data.scene.cameraTracks) {
      for (const kf of cameraTrackToThree(track).keyframes) {
        expect(kf.position[1]).toBeGreaterThan(0);
      }
    }
  });
});

describe('parseManifestCameras', () => {
  it('parses and converts the golden manifest in one step', () => {
    const result = parseManifestCameras(manifestFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks).toHaveLength(1);
    expect(result.manifest.timeRangeMs[1] - result.manifest.timeRangeMs[0]).toBe(14000);
  });

  it('returns typed contract errors verbatim for invalid manifests', () => {
    const bad = manifestFixture();
    bad.scene.cameraTracks[0]!.keyframes[1]!.tMs = 0; // nonmonotonic
    const result = parseManifestCameras(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[1].tMs'),
    ).toBe(true);
  });
});
