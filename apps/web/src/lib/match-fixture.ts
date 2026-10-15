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

export async function loadGoldenMatch(): Promise<GoldenMatchStatus> {
  const fixturesRoot = process.env['KYNELOOM_FIXTURES_DIR']?.trim()
    ? path.resolve(process.env['KYNELOOM_FIXTURES_DIR'].trim())
    : resolveWorkspaceFixturesRoot();
  const dir = path.join(fixturesRoot, 'generated', CANONICAL_SEED_DIR);

  let eventsRaw: string;
  let trackingRaw: string;
  let metadataRaw: string;
  try {
    eventsRaw = await readFile(path.join(dir, 'events.json'), 'utf-8');
    trackingRaw = await readFile(path.join(dir, 'tracking.jsonl'), 'utf-8');
    metadataRaw = await readFile(path.join(dir, 'metadata.json'), 'utf-8');
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: `Committed golden fixture not found under ${path.relative(process.cwd(), dir)}. The surfaces below render truthful empty states; nothing is fabricated.`,
    };
  }

  let metadata: {
    matchId: string;
    seed: number;
    narrative: string;
    generatorVersion: string;
    sampling: { goldenWindowMs: [number, number]; sampleCount: number };
    goldenCheckpointMs: number;
    scoreTimeline: { atMs: number; score: string }[];
    eventCount: number;
  };
  const events: unknown[] = JSON.parse(eventsRaw) as unknown[];
  const tracking: unknown[] = trackingRaw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  try {
    metadata = JSON.parse(metadataRaw) as typeof metadata;
  } catch {
    return { ok: false, reason: 'invalid', message: 'Fixture metadata.json is malformed.' };
  }

  const projected = projectMatch(
    { matchId: metadata.matchId, events, tracking },
    { possessionValidityMs: 10_000 },
  );
  if (projected.acceptedEvents.length === 0) {
    return {
      ok: false,
      reason: 'invalid',
      message:
        'The reducer accepted zero events from the committed fixture — refusing to render invented match data.',
    };
  }

  const checkpointMs = metadata.goldenCheckpointMs;
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
      finalScore: ((): { home: number; away: number } => {
        const end = projected.matchStateAt(metadata.sampling.goldenWindowMs[1] + 1);
        return { home: end.score.home, away: end.score.away };
      })(),
      eventCount: projected.acceptedEvents.length,
      sampleCount: metadata.sampling.sampleCount,
      projected,
    },
  };
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
