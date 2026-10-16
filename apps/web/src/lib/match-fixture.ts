import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectMatch, type ProjectedMatch } from '@kyneloom/match-core';
import type { MatchEvent, MatchState, TrackingSample } from '@kyneloom/contracts';

/**
 * Server-side bridge from the committed golden fixture to the authoritative
 * reducer (KYN-05). Explore/Studio/Viewer surfaces read match facts ONLY
 * through this seam — the same single source of truth the 3D renderer will
 * consume. Server components only (uses node:fs).
 *
 * Failure contract (PR #36 review): malformed events.json / tracking.jsonl /
 * metadata.json, unreadable files and downstream projection errors NEVER
 * throw out of loadGoldenMatch() — they return a truthful {ok:false} status
 * with a stable, user-safe message. Detailed diagnostics (including the
 * resolved fixture directory) go to the server log only, never into the
 * message the UI renders.
 */

export interface GoldenMatchData {
  readonly matchId: string;
  readonly seed: number;
  readonly narrative: string;
  readonly generatorVersion: string;
  readonly goldenWindowMs: readonly [number, number];
  readonly checkpointMs: number;
  readonly scoreTimeline: readonly { atMs: number; score: string }[];
  readonly stateAtCheckpoint: MatchState;
  readonly finalScore: { readonly home: number; readonly away: number };
  readonly eventCount: number;
  readonly sampleCount: number;
  readonly projected: ProjectedMatch;
}

export type GoldenMatchStatus =
  | { readonly ok: true; readonly data: GoldenMatchData }
  | { readonly ok: false; readonly reason: 'unavailable' | 'invalid'; readonly message: string };

const CANONICAL_SEED_DIR = 'synthetic-derby-01';

interface GoldenFixtureMetadata {
  readonly matchId: string;
  readonly seed: number;
  readonly narrative: string;
  readonly generatorVersion: string;
  readonly sampling: { readonly goldenWindowMs: [number, number]; readonly sampleCount: number };
  readonly goldenCheckpointMs: number;
  readonly scoreTimeline: readonly { atMs: number; score: string }[];
}

const TRUTHFUL_TAIL = 'The surfaces below render truthful empty states; nothing is fabricated.';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Log rich diagnostics server-side; hand the caller a path-free message. */
function fixtureFailure(
  reason: 'unavailable' | 'invalid',
  message: string,
  logDetail: string,
  dir: string,
): GoldenMatchStatus {
  console.error(`[kyneloom:fixture] ${logDetail} (resolved fixture directory: ${dir})`);
  return { ok: false, reason, message };
}

/**
 * Structural validation of metadata.json — the fields the surfaces actually
 * consume. Throws a descriptive Error; callers translate that into the
 * invalid-fixture status. Never cast JSON to a TS type and dereference.
 */
function parseFixtureMetadata(raw: string): GoldenFixtureMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('root is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const requireField = (key: string, kind: 'string' | 'number'): void => {
    if (typeof record[key] !== kind) {
      throw new Error(`field "${key}" must be a ${kind}`);
    }
  };
  requireField('matchId', 'string');
  requireField('seed', 'number');
  requireField('narrative', 'string');
  requireField('generatorVersion', 'string');
  requireField('goldenCheckpointMs', 'number');

  const sampling = record['sampling'];
  if (typeof sampling !== 'object' || sampling === null) {
    throw new Error('field "sampling" must be an object');
  }
  const samplingRecord = sampling as Record<string, unknown>;
  if (typeof samplingRecord['sampleCount'] !== 'number') {
    throw new Error('field "sampling.sampleCount" must be a number');
  }
  const window = samplingRecord['goldenWindowMs'];
  if (
    !Array.isArray(window) ||
    window.length !== 2 ||
    !window.every((value) => typeof value === 'number')
  ) {
    throw new Error('field "sampling.goldenWindowMs" must be [number, number]');
  }
  const scoreTimeline = record['scoreTimeline'];
  if (!Array.isArray(scoreTimeline)) {
    throw new Error('field "scoreTimeline" must be an array');
  }
  scoreTimeline.forEach((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>)['atMs'] !== 'number' ||
      typeof (entry as Record<string, unknown>)['score'] !== 'string'
    ) {
      throw new Error('field "scoreTimeline" entries must be { atMs: number; score: string }');
    }
  });

  return {
    matchId: record['matchId'] as string,
    seed: record['seed'] as number,
    narrative: record['narrative'] as string,
    generatorVersion: record['generatorVersion'] as string,
    sampling: {
      goldenWindowMs: [window[0] as number, window[1] as number],
      sampleCount: samplingRecord['sampleCount'] as number,
    },
    goldenCheckpointMs: record['goldenCheckpointMs'] as number,
    scoreTimeline: scoreTimeline as { atMs: number; score: string }[],
  };
}

export async function loadGoldenMatch(): Promise<GoldenMatchStatus> {
  const fixturesRoot = process.env['KYNELOOM_FIXTURES_DIR']?.trim()
    ? path.resolve(process.env['KYNELOOM_FIXTURES_DIR'].trim())
    : resolveWorkspaceFixturesRoot();
  const dir = path.join(fixturesRoot, 'generated', CANONICAL_SEED_DIR);
  const invalidMessage = (what: string): string =>
    `Invalid golden fixture (${CANONICAL_SEED_DIR}): ${what}. ${TRUTHFUL_TAIL}`;

  let eventsRaw: string;
  let trackingRaw: string;
  let metadataRaw: string;
  try {
    eventsRaw = await readFile(path.join(dir, 'events.json'), 'utf-8');
    trackingRaw = await readFile(path.join(dir, 'tracking.jsonl'), 'utf-8');
    metadataRaw = await readFile(path.join(dir, 'metadata.json'), 'utf-8');
  } catch (error) {
    return fixtureFailure(
      'unavailable',
      `Golden fixture unavailable (${CANONICAL_SEED_DIR}). ${TRUTHFUL_TAIL}`,
      `fixture files could not be read (${errorText(error)})`,
      dir,
    );
  }

  let events: unknown[];
  try {
    const parsed: unknown = JSON.parse(eventsRaw);
    if (!Array.isArray(parsed)) {
      throw new Error('root is not a JSON array');
    }
    events = parsed;
  } catch (error) {
    return fixtureFailure(
      'invalid',
      invalidMessage('events.json failed validation'),
      `events.json parse failed (${errorText(error)})`,
      dir,
    );
  }

  const tracking: unknown[] = [];
  const trackingLines = trackingRaw.split('\n');
  for (let index = 0; index < trackingLines.length; index += 1) {
    const line = (trackingLines[index] ?? '').trim();
    if (line.length === 0) continue;
    try {
      tracking.push(JSON.parse(line));
    } catch (error) {
      return fixtureFailure(
        'invalid',
        invalidMessage('tracking.jsonl failed validation'),
        `tracking.jsonl line ${index + 1} parse failed (${errorText(error)})`,
        dir,
      );
    }
  }

  let metadata: GoldenFixtureMetadata;
  try {
    metadata = parseFixtureMetadata(metadataRaw);
  } catch (error) {
    return fixtureFailure(
      'invalid',
      invalidMessage('metadata.json failed validation'),
      `metadata.json invalid (${errorText(error)})`,
      dir,
    );
  }

  let projected: ProjectedMatch;
  try {
    projected = projectMatch(
      { matchId: metadata.matchId, events, tracking },
      { possessionValidityMs: 10_000 },
    );
  } catch (error) {
    return fixtureFailure(
      'invalid',
      invalidMessage('the reducer could not project it'),
      `projectMatch threw (${errorText(error)})`,
      dir,
    );
  }
  if (projected.acceptedEvents.length === 0) {
    return fixtureFailure(
      'invalid',
      `The reducer accepted zero events from the committed fixture — refusing to render invented match data.`,
      'projectMatch accepted zero events',
      dir,
    );
  }

  try {
    const checkpointMs = metadata.goldenCheckpointMs;
    const end = projected.matchStateAt(metadata.sampling.goldenWindowMs[1] + 1);
    return {
      ok: true,
      data: {
        matchId: metadata.matchId,
        seed: metadata.seed,
        narrative: metadata.narrative,
        generatorVersion: metadata.generatorVersion,
        goldenWindowMs: metadata.sampling.goldenWindowMs,
        checkpointMs,
        scoreTimeline: metadata.scoreTimeline,
        stateAtCheckpoint: projected.matchStateAt(checkpointMs),
        finalScore: { home: end.score.home, away: end.score.away },
        eventCount: projected.acceptedEvents.length,
        sampleCount: metadata.sampling.sampleCount,
        projected,
      },
    };
  } catch (error) {
    return fixtureFailure(
      'invalid',
      invalidMessage('derived match state failed validation'),
      `state derivation threw (${errorText(error)})`,
      dir,
    );
  }
}

function resolveWorkspaceFixturesRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')))
      return path.join(dir, 'tests', 'fixtures');
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(process.cwd(), 'tests', 'fixtures');
    dir = parent;
  }
}

/** Format absolute match-relative ms as a broadcast clock MM:SS. */
export function formatMatchClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export type { MatchEvent, TrackingSample };
