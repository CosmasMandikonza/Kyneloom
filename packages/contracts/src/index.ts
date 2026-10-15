export {
  FIXTURE_INDEX_SCHEMA_VERSION,
  parseFixtureIndex,
  describeFixtureIndexError,
  type FixtureEntry,
  type FixtureIndex,
  type FixtureIndexError,
  type FixtureIndexResult,
} from './fixture-index';

export {
  toContractValidationErrors,
  type ContractValidationError,
  type ContractErrorCode,
  type ParseResult,
} from './errors';

export {
  KEBAB_ID_PATTERN,
  ENTITY_ID_PATTERN,
  SOURCE_HASH_PATTERN,
  LANGUAGE_TAG_PATTERN,
  kebabId,
  nonEmptyId,
  entityId,
  teamId,
  sourceHash,
  languageTag,
  utcTimestamp,
  isBallEntity,
  entityTeam,
  type EntityId,
  type TeamId,
  type SourceHash,
} from './ids';

export {
  DATA_ORIGINS,
  EVENT_ORIGINS,
  SAMPLE_ORIGINS,
  CLAIM_STATUSES,
  SAMPLE_VISIBILITIES,
  reconstructionDisclosure,
  sampleVisibility,
  confidence,
  type DataOrigin,
  type EventOrigin,
  type SampleOrigin,
  type ClaimStatus,
  type SampleVisibility,
  type ReconstructionDisclosure,
} from './data-origin';

export {
  PITCH_COORDINATE_SYSTEM,
  MAX_ABS_COORDINATE_M,
  vec2M,
  vec3M,
  vec3TupleM,
  pitchToThree,
  threeToPitch,
  type PitchCoordinateSystem,
  type Vec2M,
  type Vec3M,
  type Vec3TupleM,
  type ThreeVec3,
} from './spatial';

export {
  MAJOR_MINOR_PATTERN,
  SEMVER_PATTERN,
  EVENT_SCHEMA_VERSION,
  TRACKING_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  majorMinorVersion,
  semver,
  unsupportedVersionError,
  MIGRATIONS,
} from './versioning';

export { assetUrl, type AssetUrl } from './asset-url';

export {
  EVENT_KINDS,
  eventKind,
  eventAttributes,
  eventProvenance,
  matchEventSchema,
  parseMatchEvent,
  type EventKind,
  type EventProvenance,
  type MatchEvent,
} from './match-event';

export { trackingSampleSchema, parseTrackingSample, type TrackingSample } from './tracking-sample';

export {
  MATCH_PERIODS,
  PLAYER_STATUSES,
  playerState,
  ballState,
  matchStateSchema,
  parseMatchState,
  type MatchPeriod,
  type PlayerStatus,
  type PlayerState,
  type BallState,
  type MatchState,
} from './match-state';

export {
  CAMERA_MODES,
  OVERLAY_KINDS,
  EVIDENCE_KINDS,
  LENSES,
  MANIFEST_STATUSES,
  MAX_MOMENT_WINDOW_MS,
  MIN_MOMENT_WINDOW_MS,
  MAX_CAMERA_KEYFRAMES,
  MAX_CAMERA_TRACKS,
  MAX_OVERLAYS,
  MAX_CLAIMS,
  MAX_EVIDENCE_ENTRIES,
  CAMERA_FOV_RANGE_DEG,
  MIN_CAMERA_HEIGHT_M,
  cameraTrack,
  cameraKeyframe,
  visualOverlay,
  claim,
  evidenceEntry,
  approvalRecord,
  releaseRecord,
  momentManifestSchema,
  parseMomentManifest,
  parseReleaseRecord,
  canonicalJsonStringify,
  manifestInputFingerprint,
  type CameraMode,
  type OverlayKind,
  type EvidenceKind,
  type Lens,
  type ManifestStatus,
  type CameraKeyframe,
  type CameraTrack,
  type VisualOverlay,
  type Claim,
  type EvidenceEntry,
  type ApprovalRecord,
  type ReleaseRecord,
  type MomentManifest,
} from './moment-manifest';

export { MANIFEST_SEMANTIC_CHECKS, type ManifestSemanticCheck } from './semantic-verification';

export { exampleMomentManifest } from './example-manifest';
