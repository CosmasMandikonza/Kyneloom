/**
 * The scripted narrative ground truth for the golden fixture
 * "The Invisible Assist" (docs/15): second half, 78th minute — home-11's
 * decoy run toward the ball drags away-03 up the pitch, the separation
 * between away-03 and home-09 grows, home-08 threads the pass through the
 * opened lane, home-09 controls, dribbles and scores the equalizer.
 *
 * All coordinates are canonical pitch meters (center origin, +x is home's
 * attacking direction in the second half, +y upper touchline). Times are
 * absolute match-relative milliseconds, snapped to the 100 ms tick grid so
 * every emitted event has an exact tracking frame.
 *
 * BEAT MAP (seconds):
 *   4717.0–4720.5  build-up: home-08 carries to (24, −2); home-11 eases
 *                  infield to (18, −12); away-03 marks tight next to
 *                  home-09 at (25, −3); home-09 idles at (24, 3).
 *   4720.5–4724.0  the decoy: home-11 sprints SHORT toward the ball to
 *                  (6, −10); away-03 follows him up the pitch to (12, −6);
 *                  home-09 starts his run in behind toward (37, −14). The
 *                  away-03↔home-09 separation opens from ≈6 m toward ≈18 m
 *                  (asserted from emitted samples, never hard-coded).
 *   4724.0         pass_attempted evt-0041 (home-08 releases).
 *   4724.0–4726.2  ball in flight ≈20 m at ≈9 m/s, loft apex 1.2 m.
 *   4726.2         pass_completed evt-0042 — home-09 controls at (40, −11).
 *   4726.2–4727.8  home-09 dribbles to (44, −8.5).
 *   4727.8         shot_attempted evt-0043 from (44, −8.5), ≈23 m/s.
 *   4728.3         goal — ball crosses x = +52.4 in the goal mouth
 *                  (y −2, z 0.9). Score becomes 1–1.
 *   4728.3–4731.0  celebration deceleration; ball settles in the net.
 */

/** A keyframed actor target within the golden window (pitch meters). */
export interface ScriptedMove {
  readonly entityId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

/** Ball carrier phases; gaps between phases are scripted flights. */
export interface CarrierPhase {
  readonly entityId: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface ScriptedFlight {
  readonly fromMs: number;
  readonly toMs: number;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Apex height in meters (0 = ground pass). */
  readonly apexZM: number;
  readonly kind: 'pass' | 'shot';
  readonly eventId: string;
}

export const GOLDEN_WINDOW_MS = { start: 4717000, end: 4731000 } as const;
export const GOLDEN_CHECKPOINT_MS = 4722100;

/** Background narrative events (all coherent with scripted ball phases). */
export const BACKGROUND_EVENT_BEATS = [
  {
    atMs: 500,
    kind: 'kickoff',
    entityId: 'home-07',
    teamId: 'home',
    attributes: { kicking_off: 'home' },
  },
  {
    atMs: 2_095_000,
    kind: 'shot_attempted',
    entityId: 'away-10',
    teamId: 'away',
    attributes: { range_m: 8.6 },
  },
  {
    atMs: 2_095_400,
    kind: 'goal',
    entityId: 'away-10',
    teamId: 'away',
    attributes: { score_after: '0-1' },
  },
  {
    atMs: 2_700_000,
    kind: 'period_end',
    entityId: null,
    teamId: null,
    attributes: { period: 'first_half' },
  },
  {
    atMs: 2_700_500,
    kind: 'period_start',
    entityId: null,
    teamId: null,
    attributes: { period: 'second_half' },
  },
  {
    atMs: 2_701_000,
    kind: 'kickoff',
    entityId: 'away-11',
    teamId: 'away',
    attributes: { kicking_off: 'away' },
  },
] as const;

export const FULL_TIME_BEAT = {
  atMs: 5_400_000,
  kind: 'period_end',
  entityId: null,
  teamId: null,
  attributes: { period: 'full_time', score: '1-1' },
} as const;

/** Golden scripted movement (non-actors hold zone anchors via the normal model). */
export const GOLDEN_GOAL_MS = 4728300;

export const GOLDEN_MOVES: readonly ScriptedMove[] = [
  // Build-up: carrier home-08 advances.
  { entityId: 'home-08', fromMs: 4714000, toMs: 4724000, from: [8, -3], to: [24, -2] },
  // Winger eases infield before the decoy sprint.
  { entityId: 'home-11', fromMs: 4714000, toMs: 4720500, from: [2, -23], to: [18, -12] },
  // away-03 marks TIGHT next to the striker's zone (small separation pre-run).
  { entityId: 'away-03', fromMs: 4714000, toMs: 4720500, from: [30, -8], to: [25, -3] },
  // Striker lurks between the lines.
  { entityId: 'home-09', fromMs: 4714000, toMs: 4720500, from: [10, 5], to: [24, 3] },
  // away-04 keeps central depth.
  { entityId: 'away-04', fromMs: 4714000, toMs: 4720500, from: [34, -10], to: [33, -6] },
  // THE DECOY: winger sprints SHORT toward the ball; away-03 follows him up
  // the pitch, AWAY from the channel the striker is about to attack.
  { entityId: 'home-11', fromMs: 4720500, toMs: 4723400, from: [18, -12], to: [3, -10] },
  { entityId: 'home-11', fromMs: 4723400, toMs: 4724000, from: [3, -10], to: [2, -10] },
  { entityId: 'away-03', fromMs: 4720500, toMs: 4723400, from: [25, -3], to: [12, -6] },
  { entityId: 'away-03', fromMs: 4723400, toMs: 4724000, from: [12, -6], to: [11, -6] },
  // The striker runs in behind into the vacated channel, far corner.
  { entityId: 'home-09', fromMs: 4720500, toMs: 4726200, from: [24, 3], to: [40, -11] },
  { entityId: 'home-09', fromMs: 4726200, toMs: 4727800, from: [40, -11], to: [44, -8.5] },
  // away-04 recovers but concedes the angle.
  { entityId: 'away-04', fromMs: 4720500, toMs: 4727800, from: [33, -6], to: [42, -10] },
  // home-08 holds to release, then eases forward through the celebration
  // (without this he would sprint back to his formation anchor at release).
  { entityId: 'home-08', fromMs: 4724000, toMs: 4724400, from: [24, -2], to: [24, -3] },
  { entityId: 'home-08', fromMs: 4724400, toMs: 4731000, from: [24, -3], to: [27, 0] },
  // Celebration: deceleration away from goal.
  { entityId: 'home-09', fromMs: 4727800, toMs: 4731000, from: [44, -8.5], to: [41, -2] },
  { entityId: 'home-11', fromMs: 4724000, toMs: 4731000, from: [2, -10], to: [24, -6] },
  { entityId: 'away-03', fromMs: 4724000, toMs: 4731000, from: [12, -6], to: [22, -12] },
];

export const GOLDEN_CARRIER_PHASES: readonly CarrierPhase[] = [
  { entityId: 'home-08', fromMs: 4717000, toMs: 4724000 },
  // flight: evt-0041 pass, 4724000 → 4726200
  { entityId: 'home-09', fromMs: 4726200, toMs: 4727800 },
  // flight: evt-0043 shot, 4727800 → 4728300 (goal at crossing)
];

export const GOLDEN_FLIGHTS: readonly ScriptedFlight[] = [
  {
    fromMs: 4724000,
    toMs: 4726200,
    from: [24, -2],
    to: [40, -11],
    apexZM: 1.2,
    kind: 'pass',
    eventId: 'evt-0041',
  },
  {
    fromMs: 4727800,
    toMs: 4728300,
    from: [44, -8.5],
    to: [52.4, -2],
    apexZM: 0.9,
    kind: 'shot',
    eventId: 'evt-0043',
  },
];

export const GOLDEN_EVENT_BEATS = [
  {
    atMs: 4724000,
    kind: 'pass_attempted',
    entityId: 'home-08',
    teamId: 'home',
    attributes: { target_player_id: 'home-09' },
  },
  {
    atMs: 4726200,
    kind: 'pass_completed',
    entityId: 'home-08',
    teamId: 'home',
    attributes: { target_player_id: 'home-09' },
  },
  {
    atMs: 4727800,
    kind: 'shot_attempted',
    entityId: 'home-09',
    teamId: 'home',
    attributes: { target_goal_x_m: 52.5 },
  },
  {
    atMs: GOLDEN_GOAL_MS,
    kind: 'goal',
    entityId: 'home-09',
    teamId: 'home',
    attributes: { score_after: '1-1' },
  },
] as const;

/**
 * Own-goal semantics (contract-compatible, documented): the `actorId` is the
 * player who put the ball into their own net; `teamId` is the team CREDITED
 * with the goal (the beneficiary); `attributes.benefiting_team` repeats the
 * credited team explicitly. The golden fixture deliberately contains no own
 * goal; this convention is exported so fault-variant tests can construct one.
 */
export const OWN_GOAL_SEMANTICS =
  'actor = player who scored into their own net; teamId = benefiting team' as const;

/**
 * Scripted movement for the first-half away-goal mini-sequence (away attacks
 * +x). The build-up starts at away-10's realistic formation position so the
 * steering integrator can actually arrive by the shot.
 */
export const AWAY_GOAL_MOVES: readonly ScriptedMove[] = [
  { entityId: 'away-10', fromMs: 2_075_000, toMs: 2_093_000, from: [-18, -8], to: [38, -6] },
  { entityId: 'away-10', fromMs: 2_093_000, toMs: 2_095_000, from: [38, -6], to: [44, -5] },
  { entityId: 'away-10', fromMs: 2_095_000, toMs: 2_097_000, from: [44, -5], to: [42, -3] },
];
/** Window in which AWAY_GOAL_MOVES apply (must cover the whole build-up). */
export const AWAY_GOAL_MOVES_WINDOW_MS = { start: 2_075_000, end: 2_097_000 } as const;
