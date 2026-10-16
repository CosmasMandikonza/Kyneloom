// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Object3D, SkinnedMesh } from 'three';

/**
 * KYN-30 asset acceptance (Node environment — no WebGL needed):
 * the SHIPPED GLB (the file the browser downloads, not the source pack)
 * carries the rig, the four locomotion clips, and clones into independent
 * skeletons that share geometry — the precondition for 22 separately
 * animated players from one 0.8 MB download.
 */

const GLB_PATH = path.resolve(__dirname, '../../../../public/models/footballer.glb');

function loadShippedGlb(): Promise<{ scene: Object3D; animations: Object3D['animations'] }> {
  const buffer = readFileSync(GLB_PATH);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      arrayBuffer,
      '',
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
      reject,
    );
  });
}

function skinnedMeshes(root: Object3D): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  root.traverse((child) => {
    if ((child as SkinnedMesh).isSkinnedMesh) meshes.push(child as SkinnedMesh);
  });
  return meshes;
}

describe('shipped footballer GLB', () => {
  it('is small enough for a public client bundle (< 1 MB)', () => {
    const bytes = readFileSync(GLB_PATH).byteLength;
    expect(bytes).toBeGreaterThan(500_000); // the rig must stay real, not gutted
    expect(bytes).toBeLessThan(1_000_000);
  });

  it('carries the four locomotion clips with sane durations', async () => {
    const { animations } = await loadShippedGlb();
    const clips = animations ?? [];
    const names = clips.map((clip) => clip.name).sort();
    expect(names).toEqual(['Idle_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Walk_Loop']);
    for (const clip of clips) {
      expect(clip.duration).toBeGreaterThan(0.2);
      expect(clip.duration).toBeLessThan(5);
    }
  });

  it('clones into independent skeletons that share geometry (SkeletonUtils)', async () => {
    const { scene } = await loadShippedGlb();
    const cloneA = SkeletonUtils.clone(scene);
    const cloneB = SkeletonUtils.clone(scene);
    const sourceMesh = skinnedMeshes(scene)[0];
    const meshA = skinnedMeshes(cloneA)[0];
    const meshB = skinnedMeshes(cloneB)[0];
    if (!sourceMesh || !meshA || !meshB) {
      throw new Error('skinned mesh missing from rig or clones');
    }

    // Independent skeletons: distinct bone objects per clone…
    const boneIdsA = meshA.skeleton.bones.map((bone) => bone.uuid);
    const boneIdsB = meshB.skeleton.bones.map((bone) => bone.uuid);
    expect(boneIdsA.length).toBeGreaterThan(20); // full-body rig, not a stub
    expect(boneIdsA).not.toEqual(boneIdsB);
    // …so posing one clone can never pose the other.
    const sharedBoneName = meshA.skeleton.bones[0]!.name;
    meshA.skeleton.bones[0]!.position.x += 0.5;
    const bBone = meshB.skeleton.bones.find((bone) => bone.name === sharedBoneName);
    expect(bBone?.position.x ?? 0).not.toBe(meshA.skeleton.bones[0]!.position.x);

    // Shared payloads: geometry and materials are referenced, not copied.
    expect(meshA.geometry).toBe(sourceMesh.geometry);
    expect(meshB.geometry).toBe(sourceMesh.geometry);
  });
});
