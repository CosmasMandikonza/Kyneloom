import type { GoldenMatchStatus, GoldenStoryFacts } from './match-fixture';
import type { SceneTeamId } from './scene-data';

/**
 * KYN-10 — the deterministic Playable Moment catalog.
 *
 * The gallery does NOT invent a second match engine or a publication
 * pipeline. Every entry is a *chapter* of the one accepted golden sequence
 * (`synthetic-derby-01`, window 4717000–4731000 ms): a validated focus
 * timestamp on the 100 ms tracking grid, an optional real source-event
 * reference, and editorial copy grounded ONLY in (a) the committed fixture
 * metadata's golden block, (b) accepted reducer events, or (c) spatial facts
 * computed right here by tested arithmetic over the accepted tracking
 * samples. Nothing in this module may claim a pass, interception, score or
 * player intent the source does not carry.
 *
 * This is deliberately NOT a MomentManifest (docs/06): these are discovery
 * selections into the existing Living Replay, not publishable scene
 * specifications, and they never mutate scene geometry.
 */

/** Cameras the viewer + preview pipeline share for deliberate framing. */
export type MomentCamera = 'broadcast' | 'overhead' | 'follow' | 'goalkeeper' | 'directed';

/** Honest source quality for everything the current corpus can offer. */
export type MomentSourceStatus = 'synthetic';

/** Whether the focus timestamp sits inside the verified X-Ray measurement interval. */
export type MomentEvidenceContext = 'measured-window' | 'outside-window';

/** Deterministic numeric facts computed from accepted tracking (never invented). */
export interface MomentFacts {
  /** Measured separation away-03 ↔ home-09 at the exact focus frame (m). */
  readonly separationM?: number;
  /** home-11's speed across the frame pair ending at focus (m/s). */
  readonly runnerSpeedMps?: number;
  /** Distance ball ↔ named entity at the exact focus frame (m). */
  readonly ballDistanceM?: { readonly entityId: string; readonly m: number };
  /** Ball position at the exact focus frame (pitch meters). */
  readonly ballAt?: { readonly xM: number; readonly yM: number };
  /** Score line in force at focus (from the metadata score timeline). */
  readonly scoreLine?: string;
  /** Seconds from focus to the equalizing goal event. */
  readonly toGoalS?: number;
  /** Pass distance release→reception, computed from tracking (m). */
  readonly passDistanceM?: number;
  /** Pass flight duration (s). */
  readonly passDurationS?: number;
  /** Striker→goal-mouth distance at the strike, computed from tracking (m). */
  readonly shotDistanceM?: number;
}

export interface MomentCatalogEntry {
  /** Stable unique catalog id (kebab-case, contracts grammar). */
  readonly catalogId: string;
  readonly matchId: string;
  /** Validated focus timestamp on the tracking grid, inside the golden window. */
  readonly focusMs: number;
  /** Real accepted source-event reference, or null for open-play beats. */
  readonly eventId: string | null;
  readonly eventKind: string | null;
  /** Real player entity the chapter is about, or null. */
  readonly playerFocusId: string | null;
  /** 1–12 for collection chapters; null for the featured presentation. */
  readonly chapter: number | null;
  /** Editorial title (grounded in supported action). */
  readonly title: string;
  /** One-line hook shown on the card. */
  readonly hook: string;
  /** Grounded tactical category chip. */
  readonly tag: string;
  readonly sourceStatus: MomentSourceStatus;
  readonly evidenceContext: MomentEvidenceContext;
  readonly previewCamera: MomentCamera;
  readonly facts: MomentFacts;
  /** Team of the player focus, when there is one. */
  readonly team: SceneTeamId | null;
}

export interface MomentCatalog {
  readonly matchId: string;
  readonly windowMs: readonly [number, number];
  readonly featured: MomentCatalogEntry;
  readonly chapters: readonly MomentCatalogEntry[];
  /**
   * The metadata's generator-recorded story facts (release speeds, authored
   * measurement summary), or null when the block is absent. Distances are
   * cross-checked against computed tracking values by buildMomentCatalog.
   */
  readonly story: GoldenStoryFacts | null;
}

export type MomentSelection =
  | { readonly status: 'none' }
  | { readonly status: 'selected'; readonly entry: MomentCatalogEntry }
  | { readonly status: 'unknown'; readonly raw: string };

/** Catalog ids match the contracts identifier grammar. */
const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The canonical X-Ray measurement interval (mirror of SEPARATION_INPUT in
 * evidence-data.ts; asserted equal by tests so the two can never drift).
 */
export const MEASURED_INTERVAL_MS: readonly [number, number] = [4_720_500, 4_724_000];

const ENTITY_BALL = 'ball';
const DEFENDER = 'away-03';
const STRIKER = 'home-09';
const RUNNER = 'home-11';

interface SamplePoint {
  readonly xM: number;
  readonly yM: number;
}

type SampleIndex = Map<string, Map<number, SamplePoint>>;

function indexSamples(
  acceptedTracking: readonly { entityId: string; sampleTimeMs: number; xM: number; yM: number }[],
  windowStart: number,
  windowEnd: number,
): SampleIndex {
  const index: SampleIndex = new Map();
  for (const sample of acceptedTracking) {
    if (sample.sampleTimeMs < windowStart || sample.sampleTimeMs > windowEnd) continue;
    let byTime = index.get(sample.entityId);
    if (byTime === undefined) {
      byTime = new Map();
      index.set(sample.entityId, byTime);
    }
    byTime.set(sample.sampleTimeMs, { xM: sample.xM, yM: sample.yM });
  }
  return index;
}

function distance(a: SamplePoint, b: SamplePoint): number {
  return Math.hypot(a.xM - b.xM, a.yM - b.yM);
}

interface ChapterSpec {
  readonly catalogId: string;
  readonly focusMs: number;
  readonly eventId: string | null;
  readonly playerFocusId: string | null;
  readonly title: string;
  readonly hook: string;
  readonly tag: string;
  readonly previewCamera: MomentCamera;
  readonly facts: (ctx: FactContext) => MomentFacts;
}

interface FactContext {
  readonly at: (entityId: string, tMs: number) => SamplePoint;
  readonly speed: (entityId: string, tMs: number) => number | null;
  readonly scoreAt: (tMs: number) => string;
  readonly goalMs: number;
}

/**
 * Chapter definitions. focusMs values sit on the 100 ms tracking grid with
 * full 23-entity coverage (asserted by buildMomentCatalog's fail-closed
 * validation and by tests). Editorial copy only cites numbers this module
 * computes or that come from the committed golden metadata.
 */
const CHAPTER_SPECS: readonly ChapterSpec[] = [
  {
    catalogId: 'ia-01-possession-settles',
    focusMs: 4_717_000,
    eventId: null,
    playerFocusId: 'home-08',
    title: 'Possession settles',
    hook: 'Open play, deep in the half chasing the equalizer — home-08 on the ball, the whole move still ahead.',
    tag: 'Build-up',
    previewCamera: 'overhead',
    facts: (c) => ({
      ballDistanceM: {
        entityId: 'home-08',
        m: distance(c.at(ENTITY_BALL, 4_717_000), c.at('home-08', 4_717_000)),
      },
      scoreLine: c.scoreAt(4_717_000),
      toGoalS: (c.goalMs - 4_717_000) / 1000,
    }),
  },
  {
    catalogId: 'ia-02-run-develops',
    focusMs: 4_721_200,
    eventId: null,
    playerFocusId: RUNNER,
    title: 'The follower hesitates',
    hook: 'home-11’s decoy run is 0.7 s old. away-03 has actually closed on home-09 — the commitment has not happened yet.',
    tag: 'Off-ball run',
    previewCamera: 'overhead',
    facts: (c) => ({
      separationM: distance(c.at(DEFENDER, 4_721_200), c.at(STRIKER, 4_721_200)),
      runnerSpeedMps: c.speed(RUNNER, 4_721_200) ?? undefined,
    }),
  },
  {
    catalogId: 'ia-03-measured-checkpoint',
    focusMs: 4_722_100,
    eventId: null,
    playerFocusId: RUNNER,
    title: 'The measured checkpoint',
    hook: 'The canonical 22-player checkpoint — the exact frame the entire fixture is verified against.',
    tag: 'Measurement',
    previewCamera: 'overhead',
    facts: (c) => ({
      separationM: distance(c.at(DEFENDER, 4_722_100), c.at(STRIKER, 4_722_100)),
      ballAt: c.at(ENTITY_BALL, 4_722_100),
      scoreLine: c.scoreAt(4_722_100),
    }),
  },
  {
    catalogId: 'ia-04-top-speed',
    focusMs: 4_723_400,
    eventId: null,
    playerFocusId: RUNNER,
    title: 'Top speed, no ball',
    hook: 'home-11 hits the fastest speed recorded in the window — on a run that never touches the ball.',
    tag: 'Off-ball run',
    previewCamera: 'overhead',
    facts: (c) => ({
      runnerSpeedMps: c.speed(RUNNER, 4_723_400) ?? undefined,
      separationM: distance(c.at(DEFENDER, 4_723_400), c.at(STRIKER, 4_723_400)),
    }),
  },
  {
    catalogId: 'ia-05-lane-opens',
    focusMs: 4_724_000,
    eventId: 'evt-0007',
    playerFocusId: 'home-08',
    title: 'The lane opens, the pass leaves',
    hook: 'Separation reaches 20.3 m and home-08 releases the thread in the same instant — space and pass are one beat.',
    tag: 'Pass',
    previewCamera: 'broadcast',
    facts: (c) => ({
      separationM: distance(c.at(DEFENDER, 4_724_000), c.at(STRIKER, 4_724_000)),
      scoreLine: c.scoreAt(4_724_000),
    }),
  },
  {
    catalogId: 'ia-06-pass-in-flight',
    focusMs: 4_725_100,
    eventId: null,
    playerFocusId: 'home-09',
    title: 'Sixteen metres in flight',
    hook: 'The ball is between owners — possessor is explicitly null while the pass covers the ground between release and reception.',
    tag: 'Pass',
    previewCamera: 'overhead',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_725_100),
      passDistanceM: distance(c.at('home-08', 4_724_000), c.at(STRIKER, 4_726_200)),
      passDurationS: (4_726_200 - 4_724_000) / 1000,
    }),
  },
  {
    catalogId: 'ia-07-reception',
    focusMs: 4_726_200,
    eventId: 'evt-0042',
    playerFocusId: 'home-09',
    title: 'Reception in the box',
    hook: 'home-09 takes the threaded pass with the penalty area ahead — evt-0042, pass completed.',
    tag: 'Pass',
    previewCamera: 'broadcast',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_726_200),
      scoreLine: c.scoreAt(4_726_200),
    }),
  },
  {
    catalogId: 'ia-08-setting-the-strike',
    focusMs: 4_727_000,
    eventId: null,
    playerFocusId: 'home-09',
    title: 'Setting the strike',
    hook: '0.8 s on the ball, the nearest away shirt a computed metre and a half away — the shot has room.',
    tag: 'Finish build',
    previewCamera: 'overhead',
    facts: (c) => ({
      ballDistanceM: {
        entityId: 'away-04',
        m: distance(c.at(ENTITY_BALL, 4_727_000), c.at('away-04', 4_727_000)),
      },
    }),
  },
  {
    catalogId: 'ia-09-the-strike',
    focusMs: 4_727_800,
    eventId: 'evt-0009',
    playerFocusId: 'home-09',
    title: 'The strike',
    hook: 'The shot leaves home-09’s foot — evt-0009 — with the goal mouth measured metres away.',
    tag: 'Finish',
    previewCamera: 'overhead',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_727_800),
      shotDistanceM: distance(c.at(STRIKER, 4_727_800), c.at(ENTITY_BALL, 4_728_300)),
      toGoalS: (c.goalMs - 4_727_800) / 1000,
    }),
  },
  {
    catalogId: 'ia-10-the-equalizer',
    focusMs: 4_728_300,
    eventId: 'evt-0010',
    playerFocusId: 'home-09',
    title: 'The equalizer',
    hook: 'The ball crosses at the goal mouth and the score turns 1–1 — evt-0010, goal.',
    tag: 'Finish',
    previewCamera: 'directed',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_728_300),
      scoreLine: c.scoreAt(4_728_300),
    }),
  },
  {
    catalogId: 'ia-11-aftermath',
    focusMs: 4_729_000,
    eventId: null,
    playerFocusId: 'home-09',
    title: 'Aftermath',
    hook: 'Score settled, ball at rest by the net. The move is 8.5 s old and finished.',
    tag: 'Aftermath',
    previewCamera: 'broadcast',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_729_000),
      scoreLine: c.scoreAt(4_729_000),
    }),
  },
  {
    catalogId: 'ia-12-last-tracked-frame',
    focusMs: 4_731_000,
    eventId: null,
    playerFocusId: null,
    title: 'The last tracked frame',
    hook: 'The golden window’s final frame. Beyond it the fixture has no positional data — absence stays explicit.',
    tag: 'Boundary',
    previewCamera: 'broadcast',
    facts: (c) => ({
      ballAt: c.at(ENTITY_BALL, 4_731_000),
      scoreLine: c.scoreAt(4_731_000),
    }),
  },
];

function buildEntry(
  spec: ChapterSpec,
  chapter: number | null,
  matchId: string,
  acceptedEventIds: ReadonlyMap<string, string>,
  ctx: FactContext,
): MomentCatalogEntry {
  if (spec.eventId !== null) {
    const kind = acceptedEventIds.get(spec.eventId);
    if (kind === undefined) {
      throw new Error(`catalog chapter ${spec.catalogId} cites unknown event ${spec.eventId}`);
    }
  }
  const inInterval =
    spec.focusMs >= MEASURED_INTERVAL_MS[0] && spec.focusMs <= MEASURED_INTERVAL_MS[1];
  const team: SceneTeamId | null =
    spec.playerFocusId === null ? null : spec.playerFocusId.startsWith('home-') ? 'home' : 'away';
  return {
    catalogId: spec.catalogId,
    matchId,
    focusMs: spec.focusMs,
    eventId: spec.eventId,
    eventKind: spec.eventId !== null ? (acceptedEventIds.get(spec.eventId) ?? null) : null,
    playerFocusId: spec.playerFocusId,
    chapter,
    title: spec.title,
    hook: spec.hook,
    tag: spec.tag,
    sourceStatus: 'synthetic',
    evidenceContext: inInterval ? 'measured-window' : 'outside-window',
    previewCamera: spec.previewCamera,
    facts: spec.facts(ctx),
    team,
  };
}

function scoreAtFactory(scoreTimeline: readonly { atMs: number; score: string }[]) {
  return (tMs: number): string => {
    let current = scoreTimeline[0]?.score ?? '0-0';
    for (const entry of scoreTimeline) {
      if (entry.atMs <= tMs) current = entry.score;
      else break;
    }
    return current;
  };
}

/**
 * Build the deterministic catalog from the accepted golden match. Returns
 * null when the fixture is unavailable/invalid — the gallery then renders
 * its honest empty state instead of fabricated chapters.
 *
 * Fail-closed validation: every chapter focus must lie inside the golden
 * window AND have an exact sample for all 23 tracked entities (22 players +
 * ball) at that frame; featured + chapter ids must be unique; chapter focus
 * timestamps must be distinct; the metadata goal timestamp must exist as an
 * event. Any violation throws — the caller treats the catalog as unbuildable
 * rather than silently shipping a degraded grid.
 */
export function buildMomentCatalog(golden: GoldenMatchStatus): MomentCatalog | null {
  if (!golden.ok) return null;
  const { projected, goldenWindowMs, matchId } = golden.data;
  const [windowStart, windowEnd] = goldenWindowMs;
  const samples = indexSamples(projected.acceptedTracking, windowStart, windowEnd);
  const entityIds = [...samples.keys()];

  const at = (entityId: string, tMs: number): SamplePoint => {
    const point = samples.get(entityId)?.get(tMs);
    if (point === undefined) {
      throw new Error(`no exact tracking sample for ${entityId} at ${tMs}`);
    }
    return point;
  };
  const speed = (entityId: string, tMs: number): number | null => {
    const current = samples.get(entityId)?.get(tMs);
    const previous = samples.get(entityId)?.get(tMs - 100);
    if (current === undefined || previous === undefined) return null;
    return distance(current, previous) / 0.1;
  };

  const acceptedEventIds = new Map<string, string>();
  let goalMs: number | null = null;
  for (const event of projected.acceptedEvents) {
    acceptedEventIds.set(event.eventId, event.kind);
    if (
      event.kind === 'goal' &&
      event.occurredAtMs >= windowStart &&
      event.occurredAtMs <= windowEnd
    ) {
      goalMs = event.occurredAtMs;
    }
  }
  if (goalMs === null) {
    throw new Error('no accepted goal event inside the golden window — catalog cannot be grounded');
  }
  const ctx: FactContext = {
    at,
    speed,
    scoreAt: scoreAtFactory(golden.data.scoreTimeline),
    goalMs,
  };

  // Full-coverage gate: 23 entities with an exact frame at every focus time.
  for (const spec of CHAPTER_SPECS) {
    if (spec.focusMs < windowStart || spec.focusMs > windowEnd) {
      throw new Error(`chapter ${spec.catalogId} focus outside the golden window`);
    }
    for (const entityId of entityIds) {
      if (!samples.get(entityId)?.has(spec.focusMs)) {
        throw new Error(
          `chapter ${spec.catalogId}: entity ${entityId} has no exact frame at focus`,
        );
      }
    }
  }
  if (entityIds.length !== 23) {
    throw new Error(`expected 23 tracked entities in the window, found ${entityIds.length}`);
  }

  // Integrity gate: the metadata's generator-recorded story must agree with
  // what the accepted tracking actually shows — distances and separations
  // are recomputed here and compared. A contradiction means the fixture and
  // its narrative have drifted apart; the catalog refuses to ship.
  if (golden.data.story !== null) {
    const story = golden.data.story;
    const within = (computed: number, recorded: number): boolean =>
      Math.abs(computed - recorded) <= 0.01;
    if (
      !within(
        distance(at(DEFENDER, story.decoyRun.fromMs), at(STRIKER, story.decoyRun.fromMs)),
        story.decoyRun.separationBeforeM,
      ) ||
      !within(
        distance(at(DEFENDER, story.decoyRun.toMs), at(STRIKER, story.decoyRun.toMs)),
        story.decoyRun.separationAfterM,
      ) ||
      !within(
        distance(
          at(story.pass.from, story.pass.attemptedMs),
          at(story.pass.to, story.pass.completedMs),
        ),
        story.pass.distanceM,
      ) ||
      !within(
        distance(at(story.shot.by, story.shot.atMs), at(ENTITY_BALL, story.shot.goalMs)),
        story.shot.distanceM,
      )
    ) {
      throw new Error(
        'metadata golden story contradicts the accepted tracking — refusing to catalog',
      );
    }
  }

  const featured: MomentCatalogEntry = {
    ...buildEntry(
      {
        catalogId: 'ia-00-invisible-assist',
        focusMs: MEASURED_INTERVAL_MS[0],
        eventId: null,
        playerFocusId: RUNNER,
        title: 'The Invisible Assist',
        hook: 'One run nobody passed to. It draws the defender, opens the lane and ends in the equalizer — every step below is measured, not narrated.',
        tag: 'Featured chapter',
        previewCamera: 'follow',
        facts: (c) => ({
          separationM: distance(
            c.at(DEFENDER, MEASURED_INTERVAL_MS[0]),
            c.at(STRIKER, MEASURED_INTERVAL_MS[0]),
          ),
          scoreLine: c.scoreAt(MEASURED_INTERVAL_MS[0]),
        }),
      },
      null,
      matchId,
      acceptedEventIds,
      ctx,
    ),
  };

  const chapters = CHAPTER_SPECS.map((spec, index) =>
    buildEntry(spec, index + 1, matchId, acceptedEventIds, ctx),
  );

  const ids = new Set([featured.catalogId, ...chapters.map((chapter) => chapter.catalogId)]);
  if (ids.size !== chapters.length + 1) {
    throw new Error('duplicate catalog ids');
  }
  const focusTimes = new Set(chapters.map((chapter) => chapter.focusMs));
  if (focusTimes.size !== chapters.length) {
    throw new Error('chapter focus timestamps are not distinct');
  }

  return { matchId, windowMs: goldenWindowMs, featured, chapters, story: golden.data.story };
}

/**
 * The safe catalog→viewer seam (server-side): map a raw query parameter to a
 * validated entry. Unknown or malformed ids NEVER reach the scene as a
 * timestamp — the caller keeps the default checkpoint and renders an honest
 * notice instead.
 */
export function resolveMomentSelection(
  catalog: MomentCatalog | null,
  raw: string | string[] | undefined,
): MomentSelection {
  if (raw === undefined || raw === '') return { status: 'none' };
  const value = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  if (!CATALOG_ID_PATTERN.test(value)) return { status: 'unknown', raw: value.slice(0, 60) };
  if (catalog === null) return { status: 'unknown', raw: value.slice(0, 60) };
  if (value === catalog.featured.catalogId) return { status: 'selected', entry: catalog.featured };
  const chapter = catalog.chapters.find((candidate) => candidate.catalogId === value);
  if (chapter === undefined) return { status: 'unknown', raw: value.slice(0, 60) };
  return { status: 'selected', entry: chapter };
}

/** Canonical explore href for a catalog entry (the only card destination). */
export function exploreHrefFor(entry: MomentCatalogEntry): string {
  return `/explore?moment=${entry.catalogId}`;
}
