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

// Authoritative reducer, timeline sampling and evidence metrics (KYN-04).
export {
  ingestMatchStream,
  type IngestedStream,
  type QuarantinedItem,
  type QuarantineReason,
  type StreamIngestOptions,
} from './reducer/ingest';
export { projectMatch, type ProjectedMatch, type ProjectOptions } from './reducer/projection';
export {
  createTimeline,
  type Timeline,
  type TimelineFrame,
  type TimelineOptions,
  type EntityTimelineSample,
  type SampleOrigin,
} from './reducer/timeline';
export {
  computeSeparation,
  separationFromTimeline,
  verifySeparationEvidence,
  fnv1aHex,
  SEPARATION_ALGORITHM_VERSION,
  type SeparationInput,
  type SeparationEvidence,
  type SeparationResult,
} from './reducer/metric-separation';

// ---------------------------------------------------------------------------
// KYN-12 — football intelligence: versioned metrics, candidates, agent tool.
// ---------------------------------------------------------------------------
export {
  type MetricResult,
  type MetricProvenance,
  type MetricVerified,
  type MetricDisclosed,
  type MetricInsufficientEvidence,
  type MetricKind,
  type MetricUnits,
  type MetricFailureCode,
  type MetricDependencies,
  type MetricCoverage,
  metricIdFor,
  metricFingerprint,
} from './intelligence/metric-result';
export {
  checkRawEndpoint,
  originEligibleForVerified,
  classifyPose,
} from './intelligence/source-quality';
export {
  nearestOpponent,
  NEAREST_OPPONENT_VERSION,
  isDefensiveRole,
  type NearestOpponentInput,
  type NearestOpponentValue,
  type NearestOpponentResult,
} from './intelligence/metric-nearest';
export {
  laneOccupancy,
  LANE_OCCUPANCY_VERSION,
  type LaneOccupancyInput,
  type LaneOccupancyValue,
  type LaneOccupancyResult,
  type LaneOccupant,
} from './intelligence/metric-lane';
export {
  offBallMovement,
  OFF_BALL_MOVEMENT_VERSION,
  type OffBallMovementInput,
  type OffBallMovementValue,
  type OffBallMovementResult,
} from './intelligence/metric-movement';
export {
  separationDelta,
  type SeparationDeltaInput,
  type SeparationDeltaValue,
  type SeparationDeltaResult,
} from './intelligence/metric-separation-adapter';
export {
  detectMomentCandidates,
  CANDIDATE_VERSION,
  CANDIDATE_WEIGHTS,
  CANDIDATE_THRESHOLDS,
  type MomentCandidate,
  type DetectionInput,
  type DetectionThresholds,
  type CandidateReasonCode,
} from './intelligence/candidates';
export {
  parseMetricQuery,
  executeMetricQuery,
  validateClaim,
  SUPPORTED_METRICS,
  METRIC_TOOL_VERSION,
  MAX_LANE_WIDTH_M,
  MAX_WINDOW_MS,
  MIN_SAMPLE_STEP_MS,
  type MetricQuery,
  type MetricQueryRequest,
  type MetricToolContext,
  type MetricToolResult,
  type ClaimInput,
  type ClaimVerdict,
} from './intelligence/agent-tool';
