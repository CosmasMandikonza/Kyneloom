import { cameraTrackToThree } from '@kyneloom/scene-renderer';
import { rescaleCameraTrackToWindow, type CompileSuccess } from '@kyneloom/moment-compiler';
import type { BroadcastCue, MomentManifest } from '@kyneloom/contracts';
import type { SceneData } from './scene-data';

/**
 * KYN-16 client-side compiled-moment view (review blocker C).
 *
 * The manifest is the single source of truth. These helpers turn a compile
 * result into exactly what the stage, overlay and recap consume — converting
 * the manifest's offset clock to the absolute match clock ONCE, and binding
 * the directed camera track to a scene — so every surface shows the SAME
 * artifact identity with no hidden second copy of anything.
 */

/** A broadcast cue on the absolute match clock (what the overlay consumes). */
export interface AbsoluteCue {
  readonly id: string;
  readonly kind: 'metric' | 'caption' | 'event_marker';
  /** Absolute match-relative ms [start, end) — the playhead's own axis. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly metricAlias?: string;
}

/** Everything the UI needs from one compiled artifact, in one identity. */
export interface CompiledMomentView {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly inputFingerprint: string;
  readonly revision: number;
  readonly status: string;
  readonly approvalNull: boolean;
  readonly momentWindowMs: readonly [number, number];
  readonly cues: readonly AbsoluteCue[];
  readonly recapHeadline: string;
  readonly recapLines: readonly {
    readonly claimId: string;
    readonly text: string;
    readonly status: 'observed' | 'calculated' | 'hypothesis';
    readonly evidenceIds: readonly string[];
    readonly inferenceDisclosure?: string;
  }[];
  readonly manifest: MomentManifest;
}

/** Map the manifest's offset-clock presentation onto the absolute match clock. */
export function compiledViewFrom(result: CompileSuccess): CompiledMomentView {
  const manifest = result.manifest;
  const momentStartMs = manifest.timeRangeMs[0];
  const presentation = manifest.presentation;
  const cues: AbsoluteCue[] = (presentation?.broadcast ?? []).map((cue: BroadcastCue) => ({
    id: cue.id,
    kind: cue.kind,
    startMs: momentStartMs + cue.startMs,
    endMs: momentStartMs + cue.endMs,
    text: cue.text,
    evidenceIds: [...cue.evidenceIds],
    ...(cue.metricAlias === undefined ? {} : { metricAlias: cue.metricAlias }),
  }));
  return {
    manifestId: manifest.manifestId,
    manifestHash: result.manifestHash,
    inputFingerprint: result.inputFingerprint,
    revision: manifest.revision,
    status: manifest.status,
    approvalNull: manifest.approval === null,
    momentWindowMs: [manifest.timeRangeMs[0], manifest.timeRangeMs[1]],
    cues,
    recapHeadline: presentation?.recap.headline ?? '',
    recapLines: (presentation?.recap.lines ?? []).map((line) => ({
      claimId: line.claimId,
      text: line.text,
      status: line.status,
      evidenceIds: [...line.evidenceIds],
      ...(line.inferenceDisclosure === undefined
        ? {}
        : { inferenceDisclosure: line.inferenceDisclosure }),
    })),
    manifest,
  };
}

/**
 * Bind a compiled manifest's directed camera to a scene: pitch→Three once
 * through the shared seam, then re-express the moment's offsets on the
 * scene's window once. The base scene's tracking, players and events are the
 * SAME accepted fixture for every valid compile of this candidate.
 */
export function sceneWithCompiledTrack(baseScene: SceneData, manifest: MomentManifest): SceneData {
  const directed = manifest.scene.cameraTracks.find((track) => track.mode === 'directed');
  if (directed === undefined) return baseScene;
  const threeTrack = cameraTrackToThree(directed);
  const rescaled = rescaleCameraTrackToWindow(
    threeTrack,
    manifest.timeRangeMs[0],
    baseScene.windowMs[0],
  );
  return { ...baseScene, directedTrack: rescaled };
}
