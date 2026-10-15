export {
  PITCH_COORDINATE_SYSTEM,
  DEFAULT_PITCH_LENGTH_M,
  DEFAULT_PITCH_WIDTH_M,
  createPitchDimensions,
  isInsidePitch,
  type PitchDimensions,
  type PitchPoint,
} from './pitch';
export { locateEvent, type EventGeometryResult } from './event-geometry';

// Seeded synthetic match simulator (KYN-03).
export { SeededRng } from './simulator/rng';
export {
  HOME_TEAM,
  AWAY_TEAM,
  ROSTERS,
  GOLDEN_ACTORS,
  attackDirection,
  type PlayerProfile,
  type PlayerRole,
} from './simulator/teams';
export {
  GOLDEN_WINDOW_MS,
  GOLDEN_CHECKPOINT_MS,
  GOLDEN_MOVES,
  GOLDEN_FLIGHTS,
  GOLDEN_EVENT_BEATS,
  OWN_GOAL_SEMANTICS,
} from './simulator/scenario';
export {
  SIMULATOR_VERSION,
  DEFAULT_MATCH_ID,
  PROVIDER_ID,
  TENANT_ID,
  MOVEMENT_ENVELOPE,
  generateMatchFixture,
  auditTimestamp,
  type SimOptions,
  type FixtureBundle,
  type FixtureMetadata,
  type GoldenMetrics,
  type ScoreChange,
} from './simulator/simulate';
export {
  duplicateEvents,
  reorderEvents,
  lateCorrection,
  dropFrames,
  ambiguousIdentities,
  type VariantReport,
} from './simulator/variants';
export {
  assembleFixtureBundle,
  type FixtureBundleSource,
  type FixtureBundleResult,
  type LoadedFixtureBundle,
  type FixtureLoadError,
} from './simulator/fixture';
