import { SAMPLE_ORIGINS, SAMPLE_VISIBILITIES, type TrackingSample } from '@kyneloom/contracts';
import { createTimeline, type Timeline } from '@kyneloom/match-core';
import type { SceneData } from './scene-data';

/**
 * Client-side rehydration of the scene-data boundary (KYN-06).
 *
 * The browser receives ONLY the serializable projection built on the server;
 * this module rebuilds the authoritative sampler from it using the SAME
 * shared `createTimeline()` implementation the server and reducer use —
 * one source of truth for sampling semantics, no second interpolator.
 *
 * Truth rule: a payload that is truncated, corrupted or incomplete is
 * REJECTED with a ScenePayloadInvalidError. Nothing is ever defaulted,
 * coerced or invented — no `?? 0` coordinates, no fabricated provenance,
 * no synthetic frame ids. Callers catch the error and show an explicit
 * invalid-scene notice instead of a plausible-but-false replay.
 */

const ORIGIN_SET: ReadonlySet<string> = new Set(SAMPLE_ORIGINS);
const VISIBILITY_SET: ReadonlySet<string> = new Set(SAMPLE_VISIBILITIES);

export class ScenePayloadInvalidError extends Error {
  constructor(details: string) {
    super(`scene payload failed validation: ${details}`);
    this.name = 'ScenePayloadInvalidError';
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIndex(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;
}

/**
 * Structural validation + verbatim rehydration in ONE pass: every field is
 * guard-checked into a narrowed local and then read into the sample —
 * nothing is defaulted, coerced or invented. Any violation throws
 * ScenePayloadInvalidError naming the offending entity/sample/field.
 */
function validateAndRehydrate(scene: SceneData): TrackingSample[] {
  if (!Array.isArray(scene.tracks) || scene.tracks.length === 0) {
    throw new ScenePayloadInvalidError('no entity tracks');
  }
  const samples: TrackingSample[] = [];
  for (const track of scene.tracks) {
    const where = `track ${String(track?.entityId)}`;
    if (typeof track?.entityId !== 'string' || track.entityId.length === 0) {
      throw new ScenePayloadInvalidError('track entityId must be a non-empty string');
    }
    const { t, xyz, o, v, c, f } = track;
    if (!Array.isArray(t) || t.length === 0) {
      throw new ScenePayloadInvalidError(`${where}: no samples`);
    }
    if (!Array.isArray(xyz) || xyz.length !== t.length * 3) {
      throw new ScenePayloadInvalidError(
        `${where}: xyz length ${xyz?.length ?? 'n/a'} != 3 x t length ${t.length}`,
      );
    }
    for (const [label, table] of [
      ['o', o],
      ['v', v],
      ['c', c],
      ['f', f],
    ] as const) {
      if (!Array.isArray(table) || table.length !== t.length) {
        throw new ScenePayloadInvalidError(
          `${where}: ${label} length ${table?.length ?? 'n/a'} != t length ${t.length}`,
        );
      }
    }
    for (let i = 0; i < t.length; i += 1) {
      const time = t[i];
      if (!isFiniteNumber(time)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} has non-finite time`);
      }
      const x = xyz[i * 3];
      const y = xyz[i * 3 + 1];
      const z = xyz[i * 3 + 2];
      if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} has non-finite coordinates`);
      }
      const oi = o[i];
      if (!isIndex(oi, scene.origins.length)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} origin index invalid`);
      }
      const origin = scene.origins[oi];
      if (typeof origin !== 'string' || !ORIGIN_SET.has(origin)) {
        throw new ScenePayloadInvalidError(
          `${where}: sample ${i} origin ${JSON.stringify(origin)} not in the contract set`,
        );
      }
      const vi = v[i];
      if (!isIndex(vi, scene.visibilities.length)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} visibility index invalid`);
      }
      const visibility = scene.visibilities[vi];
      if (typeof visibility !== 'string' || !VISIBILITY_SET.has(visibility)) {
        throw new ScenePayloadInvalidError(
          `${where}: sample ${i} visibility ${JSON.stringify(visibility)} not in the contract set`,
        );
      }
      const ci = c[i];
      if (!isIndex(ci, scene.confidences.length)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} confidence index invalid`);
      }
      const confidence = scene.confidences[ci];
      if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1) {
        throw new ScenePayloadInvalidError(
          `${where}: sample ${i} confidence ${JSON.stringify(confidence)} outside [0, 1]`,
        );
      }
      const fi = f[i];
      if (!isIndex(fi, scene.frameIds.length)) {
        throw new ScenePayloadInvalidError(`${where}: sample ${i} frame-id index invalid`);
      }
      const frameId = scene.frameIds[fi];
      if (typeof frameId !== 'string' || frameId.length === 0) {
        throw new ScenePayloadInvalidError(
          `${where}: sample ${i} source frame id must be a non-empty string`,
        );
      }
      samples.push({
        schemaVersion: scene.schemaVersion,
        matchId: scene.matchId,
        sampleTimeMs: time,
        entityId: track.entityId,
        xM: x,
        yM: y,
        zM: z,
        origin: origin as TrackingSample['origin'],
        confidence,
        visibility: visibility as TrackingSample['visibility'],
        sourceFrameId: frameId,
      });
    }
  }
  const hasBall = scene.tracks.some((track) => track.entityId === scene.ballEntityId);
  if (!hasBall) {
    throw new ScenePayloadInvalidError(
      `no track for ball entity ${JSON.stringify(scene.ballEntityId)}`,
    );
  }
  return samples;
}

function validateRoster(scene: SceneData): void {
  if (!Array.isArray(scene.players) || scene.players.length === 0) {
    throw new ScenePayloadInvalidError('no players');
  }
  for (const player of scene.players) {
    if (
      typeof player?.entityId !== 'string' ||
      (player.team !== 'home' && player.team !== 'away') ||
      !isFiniteNumber(player.shirtNumber) ||
      typeof player.role !== 'string'
    ) {
      throw new ScenePayloadInvalidError(
        `player entry ${JSON.stringify(player?.entityId)} is incomplete`,
      );
    }
  }
}

export function tracksToSamples(scene: SceneData): TrackingSample[] {
  validateRoster(scene);
  return validateAndRehydrate(scene);
}

export function sceneTimeline(scene: SceneData): Timeline {
  return createTimeline(tracksToSamples(scene));
}

export function playerLookup(
  scene: SceneData,
): ReadonlyMap<string, (typeof scene.players)[number]> {
  return new Map(scene.players.map((player) => [player.entityId, player]));
}
