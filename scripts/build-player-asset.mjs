/**
 * KYN-30 asset pipeline: extract the footballer rig from the CC0 Quaternius
 * Universal Animation Library (UAL1) into the compact GLB the Living Replay
 * serves. Reproducible alternative to a Blender pass (docs/19): same input
 * bytes in, same output bytes out, no manual steps, no animation resampling
 * (tracks are copied verbatim — the source clips are already compact).
 *
 * Usage:
 *   node scripts/build-player-asset.mjs [path/to/UAL1_Standard.glb]
 *
 * Source pack: "Universal Animation Library" by Quaternius, CC0 1.0.
 *   https://quaternius.com/packs/universalanimationlibrary.html
 *   itch upload "Universal Animation Library[Standard].zip"
 *   sha256 cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724
 *   The raw pack is NOT committed; only the processed subset below ships.
 *
 * Output: apps/web/public/models/footballer.glb — skinned mannequin
 * (65-bone humanoid rig, both materials) + in-place locomotion clips:
 * Idle_Loop, Walk_Loop, Jog_Fwd_Loop, Sprint_Loop. Finger-bone channels are
 * dropped (invisible at replay distance; fingers hold the bind pose).
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';

const KEPT_CLIPS = new Set(['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop']);
const FINGER = /(?:index|middle|ring|pinky|thumb)_\d+/i;
const OUT_PATH = path.resolve('apps/web/public/models/footballer.glb');
const OUT_TMP = OUT_PATH + '.building.glb';

const sourcePath = path.resolve(process.argv[2] ?? 'UAL1_Standard.glb');
const { json: src, buffer: srcBin } = await readGlb(sourcePath);

// ---- one output buffer; accessors copied verbatim, 4-byte aligned ----
const outViews = [];
const outAccessors = [];
let outBuffer = new Uint8Array(0);

function pushAccessor(index) {
  const acc = src.accessors[index];
  const view = src.bufferViews[acc.bufferView];
  if (view.byteStride !== undefined && view.byteStride !== 0) {
    throw new Error('strided bufferView is not supported');
  }
  const compBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
  const length = acc.count * comps * compBytes;
  const srcOffset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const bytes = srcBin.subarray(srcOffset, srcOffset + length);
  const padding = (4 - (outBuffer.length % 4)) % 4;
  const merged = new Uint8Array(outBuffer.length + padding + length);
  merged.set(outBuffer, 0);
  merged.set(bytes, outBuffer.length + padding);
  outBuffer = merged;
  outViews.push({ buffer: 0, byteOffset: outBuffer.length - length, byteLength: length });
  outAccessors.push({
    bufferView: outViews.length - 1,
    componentType: acc.componentType,
    count: acc.count,
    type: acc.type,
    ...(acc.min !== undefined ? { min: acc.min } : {}),
    ...(acc.max !== undefined ? { max: acc.max } : {}),
  });
  return outAccessors.length - 1;
}

// ---- mesh primitives: keep POSITION/NORMAL/JOINTS_0/WEIGHTS_0 + indices ----
const DROP_ATTRS = new Set(['TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0']);
const outMeshes = src.meshes.map((mesh) => ({
  name: mesh.name,
  primitives: mesh.primitives.map((prim) => ({
    attributes: Object.fromEntries(
      Object.entries(prim.attributes)
        .filter(([semantic]) => !DROP_ATTRS.has(semantic))
        .map(([semantic, accessor]) => [semantic, pushAccessor(accessor)]),
    ),
    ...(prim.indices !== undefined ? { indices: pushAccessor(prim.indices) } : {}),
    material: prim.material,
    ...(prim.mode !== undefined ? { mode: prim.mode } : {}),
  })),
}));

// ---- skin: joints kept by index; inverse bind matrices copied ----
const outSkins = src.skins.map((skin) => ({
  joints: [...skin.joints],
  ...(skin.skeleton !== undefined ? { skeleton: skin.skeleton } : {}),
  inverseBindMatrices: pushAccessor(skin.inverseBindMatrices),
}));

// ---- animations: verbatim tracks, finger channels dropped ----
const outAnimations = [];
let droppedChannels = 0;
for (const anim of src.animations) {
  if (!KEPT_CLIPS.has(anim.name)) continue;
  const kept = new Map(); // source sampler index -> output sampler index
  const samplers = [];
  const channels = [];
  for (const channel of anim.channels) {
    const nodeName = src.nodes[channel.target.node]?.name ?? '';
    if (FINGER.test(nodeName)) {
      droppedChannels += 1;
      continue;
    }
    if (!kept.has(channel.sampler)) {
      const s = anim.samplers[channel.sampler];
      samplers.push({
        input: pushAccessor(s.input),
        output: pushAccessor(s.output),
        interpolation: s.interpolation ?? 'LINEAR',
      });
      kept.set(channel.sampler, samplers.length - 1);
    }
    channels.push({ sampler: kept.get(channel.sampler), target: { ...channel.target } });
  }
  outAnimations.push({ name: anim.name, channels, samplers });
}

// ---- document: nodes, scenes, materials copied as-is ----
const doc = {
  asset: { version: '2.0', generator: 'Kyneloom build-player-asset (Quaternius UAL1 subset, CC0)' },
  scene: src.scene,
  scenes: src.scenes,
  nodes: src.nodes,
  meshes: outMeshes,
  skins: outSkins,
  materials: src.materials,
  animations: outAnimations,
  accessors: outAccessors,
  bufferViews: outViews,
  buffers: [{ byteLength: outBuffer.length }],
};

await mkdir(path.dirname(OUT_PATH), { recursive: true });
await writeGlb(OUT_TMP, doc, outBuffer);
await rename(OUT_TMP, OUT_PATH);

const sourceBytes = (await stat(sourcePath)).size;
const outBytes = (await stat(OUT_PATH)).size;
console.log(
  `[build-player-asset] source ${path.basename(sourcePath)}: ${sourceBytes.toLocaleString('en-US')} B`,
);
console.log(
  `[build-player-asset] clips kept: ${outAnimations
    .map((a) => a.name)
    .sort()
    .join(', ')} ` + `(${droppedChannels} finger channels dropped)`,
);
console.log(`[build-player-asset] wrote ${OUT_PATH}: ${outBytes.toLocaleString('en-US')} B`);

// ---- GLB read/write ----
async function readGlb(file) {
  const data = await readFile(file);
  if (data.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  const jsonLength = data.readUInt32LE(12);
  const binHeader = 20 + jsonLength;
  const binLength = data.readUInt32LE(binHeader);
  const binStart = binHeader + 8;
  return {
    json: JSON.parse(data.subarray(20, 20 + jsonLength).toString('utf-8')),
    buffer: data.subarray(binStart, binStart + binLength),
  };
}

async function writeGlb(file, json, binary) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf-8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binary.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binary.length + binPad;
  const out = Buffer.alloc(total);
  let p = 0;
  out.writeUInt32LE(0x46546c67, p);
  p += 4;
  out.writeUInt32LE(2, p);
  p += 4;
  out.writeUInt32LE(total, p);
  p += 4;
  out.writeUInt32LE(jsonBytes.length + jsonPad, p);
  p += 4;
  out.writeUInt32LE(0x4e4f534a, p);
  p += 4;
  jsonBytes.copy(out, p);
  p += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) out[p++] = 0x20;
  out.writeUInt32LE(binary.length + binPad, p);
  p += 4;
  out.writeUInt32LE(0x004e4942, p);
  p += 4;
  out.set(binary, p);
  await writeFile(file, out);
}
