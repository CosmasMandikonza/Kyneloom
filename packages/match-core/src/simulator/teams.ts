/**
 * Fictional rosters, formations and per-half attack directions.
 *
 * Attack directions are stored per half (docs/05) and NEVER inferred from
 * colors: home attacks −x in the first half and +x in the second half, so
 * the golden 78th-minute goal (second half) is scored into the goal at
 * x = +52.5 m. Anchors below are expressed in the team's own attacking
 * frame (+x = towards the opponent's goal) and mirrored at runtime.
 */
import type { TeamId } from '@kyneloom/contracts';

export const HOME_TEAM = 'northbridge-athletic' as const;
export const AWAY_TEAM = 'vale-rovers' as const;

export type PlayerRole = 'goalkeeper' | 'back' | 'midfielder' | 'winger' | 'striker';

export interface PlayerProfile {
  readonly entityId: string;
  readonly teamId: TeamId;
  readonly shirtNumber: number;
  readonly role: PlayerRole;
  /** Formation anchor in attack-relative meters: +x towards opponent goal. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** Sprint ceiling used by the movement model (m/s). Simplified, not a biomechanical claim. */
  readonly maxSpeedMps: number;
}

const HOME_ROSTER: readonly PlayerProfile[] = [
  {
    entityId: 'home-01',
    teamId: 'home',
    shirtNumber: 1,
    role: 'goalkeeper',
    anchor: { x: -48, y: 0 },
    maxSpeedMps: 5.2,
  },
  {
    entityId: 'home-02',
    teamId: 'home',
    shirtNumber: 2,
    role: 'back',
    anchor: { x: -35, y: -22 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'home-03',
    teamId: 'home',
    shirtNumber: 3,
    role: 'back',
    anchor: { x: -35, y: -8 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'home-04',
    teamId: 'home',
    shirtNumber: 4,
    role: 'back',
    anchor: { x: -35, y: 8 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'home-05',
    teamId: 'home',
    shirtNumber: 5,
    role: 'back',
    anchor: { x: -35, y: 22 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'home-06',
    teamId: 'home',
    shirtNumber: 6,
    role: 'midfielder',
    anchor: { x: -15, y: -12 },
    maxSpeedMps: 7.8,
  },
  {
    entityId: 'home-07',
    teamId: 'home',
    shirtNumber: 7,
    role: 'midfielder',
    anchor: { x: -12, y: 0 },
    maxSpeedMps: 7.8,
  },
  {
    entityId: 'home-08',
    teamId: 'home',
    shirtNumber: 8,
    role: 'midfielder',
    anchor: { x: -15, y: 12 },
    maxSpeedMps: 7.9,
  },
  {
    entityId: 'home-09',
    teamId: 'home',
    shirtNumber: 9,
    role: 'striker',
    anchor: { x: 5, y: 0 },
    maxSpeedMps: 8.4,
  },
  {
    entityId: 'home-10',
    teamId: 'home',
    shirtNumber: 10,
    role: 'winger',
    anchor: { x: 0, y: 24 },
    maxSpeedMps: 8.6,
  },
  {
    entityId: 'home-11',
    teamId: 'home',
    shirtNumber: 11,
    role: 'winger',
    anchor: { x: 0, y: -24 },
    maxSpeedMps: 8.6,
  },
];

const AWAY_ROSTER: readonly PlayerProfile[] = [
  {
    entityId: 'away-01',
    teamId: 'away',
    shirtNumber: 1,
    role: 'goalkeeper',
    anchor: { x: -48, y: 0 },
    maxSpeedMps: 5.2,
  },
  {
    entityId: 'away-02',
    teamId: 'away',
    shirtNumber: 2,
    role: 'back',
    anchor: { x: -35, y: 22 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'away-03',
    teamId: 'away',
    shirtNumber: 3,
    role: 'back',
    anchor: { x: -35, y: -22 },
    maxSpeedMps: 7.5,
  },
  {
    entityId: 'away-04',
    teamId: 'away',
    shirtNumber: 4,
    role: 'back',
    anchor: { x: -34, y: -8 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'away-05',
    teamId: 'away',
    shirtNumber: 5,
    role: 'back',
    anchor: { x: -34, y: 8 },
    maxSpeedMps: 7.4,
  },
  {
    entityId: 'away-06',
    teamId: 'away',
    shirtNumber: 6,
    role: 'midfielder',
    anchor: { x: -14, y: -25 },
    maxSpeedMps: 7.6,
  },
  {
    entityId: 'away-07',
    teamId: 'away',
    shirtNumber: 7,
    role: 'midfielder',
    anchor: { x: -12, y: -9 },
    maxSpeedMps: 7.7,
  },
  {
    entityId: 'away-08',
    teamId: 'away',
    shirtNumber: 8,
    role: 'midfielder',
    anchor: { x: -12, y: 9 },
    maxSpeedMps: 7.7,
  },
  {
    entityId: 'away-09',
    teamId: 'away',
    shirtNumber: 9,
    role: 'midfielder',
    anchor: { x: -14, y: 25 },
    maxSpeedMps: 7.6,
  },
  {
    entityId: 'away-10',
    teamId: 'away',
    shirtNumber: 10,
    role: 'striker',
    anchor: { x: -24, y: -8 },
    maxSpeedMps: 8.3,
  },
  {
    entityId: 'away-11',
    teamId: 'away',
    shirtNumber: 11,
    role: 'striker',
    anchor: { x: -24, y: 8 },
    maxSpeedMps: 8.3,
  },
];

export const ROSTERS = { home: HOME_ROSTER, away: AWAY_ROSTER } as const;

/** Attack direction sign for a team in a half: +1 means attacking +x. */
export function attackDirection(team: TeamId, half: 'first' | 'second'): 1 | -1 {
  const homeFirstHalf = -1; // home attacks −x first half, +x second half
  if (team === 'home') return half === 'first' ? (homeFirstHalf as -1) : 1;
  return half === 'first' ? 1 : -1;
}

/**
 * The golden-sequence actors. away-03 marks home-11's flank and is the
 * defender drawn by the decoy run; away-04 is the center back whose lane
 * opens; home-08 plays the pass; home-09 scores; home-11 is the invisible
 * assist.
 */
export const GOLDEN_ACTORS = {
  winger: 'home-11',
  drawnDefender: 'away-03',
  passer: 'home-08',
  scorer: 'home-09',
  coveringBack: 'away-04',
} as const;
