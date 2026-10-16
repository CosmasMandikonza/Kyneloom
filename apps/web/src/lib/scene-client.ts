import type { TrackingSample } from '@kyneloom/contracts';
import { createTimeline, type Timeline } from '@kyneloom/match-core';
import type { SceneData } from './scene-data';

/**
 * Client-side rehydration of the scene-data boundary (KYN-06).
 *
 * The browser receives ONLY the serializable projection built on the server;
 * this module rebuilds the authoritative sampler from it using the SAME
 * shared `createTimeline()` implementation the server and reducer use —
 * one source of truth for sampling semantics, no second interpolator.
 * Rehydrated samples are verbatim: coordinates, origins, confidences,
 * visibilities and source frame ids round-trip unchanged.
 */

export function tracksToSamples(scene: SceneData): TrackingSample[] {
  const samples: TrackingSample[] = [];
  for (const track of scene.tracks) {
    for (let i = 0; i < track.t.length; i += 1) {
      samples.push({
        schemaVersion: scene.schemaVersion,
        matchId: scene.matchId,
        sampleTimeMs: track.t[i] ?? 0,
        entityId: track.entityId,
        xM: track.xyz[i * 3] ?? 0,
        yM: track.xyz[i * 3 + 1] ?? 0,
        zM: track.xyz[i * 3 + 2] ?? 0,
        origin: (scene.origins[track.o[i] ?? 0] ??
          'synthetic_ground_truth') as TrackingSample['origin'],
        confidence: scene.confidences[track.c[i] ?? 0] ?? 1,
        visibility: (scene.visibilities[track.v[i] ?? 0] ??
          'tracked') as TrackingSample['visibility'],
        sourceFrameId: scene.frameIds[track.f[i] ?? 0] ?? `frame-unknown-${i}`,
      });
    }
  }
  return samples;
}

export function sceneTimeline(scene: SceneData): Timeline {
  return createTimeline(tracksToSamples(scene));
}

export function playerLookup(
  scene: SceneData,
): ReadonlyMap<string, (typeof scene.players)[number]> {
  return new Map(scene.players.map((player) => [player.entityId, player]));
}
