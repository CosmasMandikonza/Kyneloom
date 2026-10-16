import { AWAY_TEAM, HOME_TEAM, ROSTERS, type PlayerProfile } from '@kyneloom/match-core';
import { parseManifestCameras, type ThreeCameraTrack } from '@kyneloom/scene-renderer';
import type { GoldenMatchStatus } from './match-fixture';
import invisibleAssistManifest from '../app/explore/scene/directed/invisible-assist.manifest.json';

/**
 * KYN-06 server→client scene-data boundary.
 *
 * The reducer, the filesystem and every function-bearing object stay on the
 * server. The browser receives ONLY this JSON-serializable projection of the
 * authoritative state: the accepted tracking samples (verbatim — the client
 * rebuilds the SAME shared `createTimeline()` sampler from them, so sampling
 * semantics have exactly one implementation in the repo), the roster metadata
 * needed to dress and identify actors, and the golden-window events.
 *
 * Interleaved positions (xyz: 3 floats per sample) and small string tables
 * (origins, source frame ids) keep the payload compact; nothing here may
 * invent, round, smooth or drop data the reducer produced.
 */

export type SceneTeamId = 'home' | 'away';

export interface ScenePlayer {
  readonly entityId: string;
  readonly team: SceneTeamId;
  readonly shirtNumber: number;
  readonly role: string;
  readonly isGoalkeeper: boolean;
}

export interface SceneEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly occurredAtMs: number;
  readonly actorId: string;
  readonly teamId: SceneTeamId;
  /**
   * Event location when the SOURCE event carries one; null when the source
   * has no position. Never defaulted to (0, 0) — overlays must not display
   * fabricated coordinates.
   */
  readonly position: { readonly xM: number; readonly yM: number } | null;
  /** Human label for chips; derived, presentation-only. */
  readonly label: string;
}

export interface SceneEntityTrack {
  readonly entityId: string;
  /** Sample times in match ms, ascending. */
  readonly t: readonly number[];
  /** Interleaved x,y,z pitch meters (length = 3 × t.length). */
  readonly xyz: readonly number[];
  /** Index into SceneData.origins per sample. */
  readonly o: readonly number[];
  /** Index into SceneData.visibilities per sample. */
  readonly v: readonly number[];
  /** Index into SceneData.confidences per sample. */
  readonly c: readonly number[];
  /** Index into SceneData.frameIds per sample. */
  readonly f: readonly number[];
}

/**
 * A validated manifest-directed camera track in Three space (KYN-07).
 * `tMs`/`startMs`/`endMs` remain OFFSETS from the window start (the
 * manifest's clock law); the rig converts them to absolute match ms
 * exactly once. Null when no valid track exists — directed mode is then
 * truthfully disabled, never fed fabricated camera poses.
 */
export type SceneDirectedTrack = ThreeCameraTrack;

export interface SceneData {
  /** Validated directed camera track for this moment, or null. */
  readonly directedTrack: SceneDirectedTrack | null;
  readonly matchId: string;
  readonly schemaVersion: string;
  readonly seed: number;
  readonly windowMs: readonly [number, number];
  readonly checkpointMs: number;
  readonly initialFocusMs: number;
  readonly teams: { readonly home: string; readonly away: string };
  readonly players: readonly ScenePlayer[];
  readonly ballEntityId: string;
  readonly tracks: readonly SceneEntityTrack[];
  readonly origins: readonly string[];
  readonly visibilities: readonly string[];
  readonly confidences: readonly number[];
  readonly frameIds: readonly string[];
  readonly events: readonly SceneEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  pass_attempted: 'Pass released',
  pass_completed: 'Pass received',
  shot_attempted: 'Shot',
  goal: 'GOAL',
};

export function buildSceneData(golden: GoldenMatchStatus): SceneData | null {
  if (!golden.ok) return null;

  const origins: string[] = [];
  const visibilities: string[] = [];
  const confidences: number[] = [];
  const frameIds: string[] = [];
  const tables = {
    o: { values: origins, index: new Map<string, number>() },
    v: { values: visibilities, index: new Map<string, number>() },
    c: { values: confidences, index: new Map<number, number>() },
    f: { values: frameIds, index: new Map<string, number>() },
  } as const;
  const intern = (
    table: { values: unknown[]; index: Map<unknown, number> },
    key: string | number,
  ): number => {
    let idx = table.index.get(key);
    if (idx === undefined) {
      idx = table.values.length;
      table.values.push(key);
      table.index.set(key, idx);
    }
    return idx;
  };

  const tracks: SceneEntityTrack[] = [];
  for (const sample of golden.data.projected.acceptedTracking) {
    let track = tracks.find((candidate) => candidate.entityId === sample.entityId);
    if (track === undefined) {
      track = { entityId: sample.entityId, t: [], xyz: [], o: [], v: [], c: [], f: [] };
      tracks.push(track);
    }
    (track.t as number[]).push(sample.sampleTimeMs);
    (track.xyz as number[]).push(sample.xM, sample.yM, sample.zM);
    (track.o as number[]).push(intern(tables.o, sample.origin));
    (track.v as number[]).push(intern(tables.v, sample.visibility));
    (track.c as number[]).push(intern(tables.c, sample.confidence));
    (track.f as number[]).push(intern(tables.f, sample.sourceFrameId));
  }
  tracks.sort((a, b) => {
    if (a.entityId === 'ball') return 1;
    if (b.entityId === 'ball') return -1;
    return a.entityId < b.entityId ? -1 : 1;
  });

  const players: ScenePlayer[] = (['home', 'away'] as const).flatMap((team) =>
    ROSTERS[team].map((profile: PlayerProfile) => ({
      entityId: profile.entityId,
      team,
      shirtNumber: profile.shirtNumber,
      role: profile.role,
      isGoalkeeper: profile.role === 'goalkeeper',
    })),
  );

  const [windowStartMs, windowEndMs] = golden.data.goldenWindowMs;
  // Strict filter: only events whose source carries a real team identity
  // ('home' | 'away') enter the scene payload — null/unknown teams would
  // otherwise be coerced into a plausible but fabricated affiliation.
  type SourceEvent = (typeof golden.data.projected.acceptedEvents)[number];
  const hasRealTeam = (event: SourceEvent): event is SourceEvent & { teamId: SceneTeamId } =>
    event.teamId === 'home' || event.teamId === 'away';
  const events: SceneEvent[] = golden.data.projected.acceptedEvents
    .filter((event) => event.occurredAtMs >= windowStartMs && event.occurredAtMs <= windowEndMs)
    .filter(hasRealTeam)
    .map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      occurredAtMs: event.occurredAtMs,
      actorId: event.actorId ?? '',
      teamId: event.teamId,
      position:
        event.position !== undefined ? { xM: event.position.xM, yM: event.position.yM } : null,
      label: EVENT_LABELS[event.kind] ?? event.kind,
    }))
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  const windowStart = golden.data.goldenWindowMs[0];
  const windowEnd = golden.data.goldenWindowMs[1];
  return {
    matchId: golden.data.matchId,
    schemaVersion: golden.data.projected.acceptedTracking[0]?.schemaVersion ?? '1.0',
    seed: golden.data.seed,
    windowMs: golden.data.goldenWindowMs,
    checkpointMs: golden.data.checkpointMs,
    initialFocusMs: golden.data.checkpointMs,
    teams: { home: HOME_TEAM, away: AWAY_TEAM },
    players,
    ballEntityId: 'ball',
    tracks,
    origins,
    visibilities,
    confidences,
    frameIds,
    events,
    directedTrack: selectDirectedTrack(windowStart, windowEnd),
  };
}

/**
 * KYN-07: parse the authored canonical manifest (docs/06 schema) through
 * the shared contract seam and expose its directed track, or null.
 *
 * Rejection rules (fail closed — never fabricate camera geometry):
 * - manifest must pass `parseMomentManifest` (every schema + bounds rule);
 * - its absolute `timeRangeMs` must equal this scene's window, so the
 *   offset→absolute clock conversion is exact;
 * - the selected track must be mode 'directed' and structurally usable
 *   (≥ 2 strictly increasing finite keyframes, finite poses, fov within
 *   20–120°, camera height ≥ 0.5 m in Three space, target not underground).
 */
export function selectDirectedTrack(
  windowStartMs: number,
  windowEndMs: number,
  manifest: unknown = invisibleAssistManifest,
): SceneDirectedTrack | null {
  const parsed = parseManifestCameras(manifest);
  if (!parsed.ok) return null;
  if (
    parsed.manifest.timeRangeMs[0] !== windowStartMs ||
    parsed.manifest.timeRangeMs[1] !== windowEndMs
  ) {
    return null;
  }
  for (const track of parsed.tracks) {
    if (track.mode !== 'directed') continue;
    if (!isStructurallyUsable(track)) continue;
    return track;
  }
  return null;
}

function isStructurallyUsable(track: SceneDirectedTrack): boolean {
  if (track.keyframes.length < 2) return false;
  let previousT = Number.NEGATIVE_INFINITY;
  for (const kf of track.keyframes) {
    if (!Number.isFinite(kf.tMs) || kf.tMs <= previousT) return false;
    previousT = kf.tMs;
    if ([...kf.position, ...kf.target].some((v) => !Number.isFinite(v))) return false;
    if (!Number.isFinite(kf.fovDeg) || kf.fovDeg < 20 || kf.fovDeg > 120) return false;
    if (kf.position[1] < 0.5 || kf.target[1] < 0) return false;
  }
  return true;
}
