import { z } from 'zod';
import type { ContractValidationError } from './errors';

/**
 * Schema versioning (docs/06 "manifest migrations/version-support policy").
 *
 * Every persisted contract carries a schema version. Parsers accept exactly
 * the supported version and fail fast with an `unsupported_version` error
 * naming the expected and found values. When a contract evolves in a
 * backwards-incompatible way, bump its supported version and register a
 * migration in {@link MIGRATIONS} rather than loosening the gate.
 *
 * Version shapes:
 * - Events, tracking samples, match state: `"major.minor"` (docs/05 examples).
 * - Moment manifests: full semver `"major.minor.patch"` (docs/06 example).
 */

export const MAJOR_MINOR_PATTERN = /^\d+\.\d+$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export const EVENT_SCHEMA_VERSION = '1.0' as const;
export const TRACKING_SCHEMA_VERSION = '1.0' as const;
export const STATE_SCHEMA_VERSION = '1.0' as const;

/**
 * v0.2.0 (KYN-16 review): adds the optional `presentation` section — the
 * canonical, content-hashed broadcast-cue and recap output bound to the
 * manifest's single approval identity. v0.1.0 documents are accepted through
 * the registered migration below (a structural no-op: 0.1.0 documents simply
 * carry no presentation).
 */
export const MANIFEST_SCHEMA_VERSION = '0.2.0' as const;

export const majorMinorVersion = z.string().regex(MAJOR_MINOR_PATTERN, {
  error: 'must be "major.minor", e.g. "1.0"',
});
export const semver = z.string().regex(SEMVER_PATTERN, {
  error: 'must be semver "major.minor.patch", e.g. "0.1.0"',
});

/** Build the typed error for a rejected schema version. */
export function unsupportedVersionError(
  field: string,
  expected: string,
  found: string,
): ContractValidationError {
  return {
    fieldPath: field,
    code: 'unsupported_version',
    message: `schema version ${JSON.stringify(found)} is not supported; this code supports ${JSON.stringify(expected)}. Register a migration before accepting newer versions.`,
  };
}

/** A registered, deterministic upgrade step between two schema versions. */
export interface SchemaMigration {
  readonly from: string;
  readonly to: string;
  readonly migrate: (input: unknown) => unknown;
}

/**
 * Registered version migrations. The first entry is the KYN-16 manifest hop
 * 0.1.0 → 0.2.0: a stamp-only migration (v0.1.0 documents are structurally
 * valid v0.2.0 documents whose optional `presentation` section is absent),
 * proven by the corpus tests that parse every committed 0.1.0 fixture
 * through it. Nothing may bypass this registry.
 *
 * PUBLICATION GATE (KYN-16 final review, for KYN-18): a stamp-migrated
 * document is a DIFFERENT document. `schemaVersion` is inside the hashed
 * `approvalContentPayload`, so 0.1.0 content re-stamped as 0.2.0 hashes
 * differently — and the 0.1.0 hash a founder approved must NEVER be
 * re-presented as covering the migrated 0.2.0 document. Release logic must
 * re-derive the hash from the migrated document and require a fresh
 * approval; approval records bind (revision, hash) pairs, not prose.
 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    from: '0.1.0',
    to: '0.2.0',
    migrate: (input: unknown): unknown => {
      if (typeof input !== 'object' || input === null) return input;
      return { ...(input as Record<string, unknown>), schemaVersion: '0.2.0' };
    },
  },
];

/**
 * Walk the registry from an older version up to `target`. Returns the
 * migrated document, or null when no registered chain exists.
 */
export function migrateDocument(
  input: unknown,
  target: string,
): { ok: true; document: unknown; from: string } | { ok: false } {
  const version =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['schemaVersion']
      : undefined;
  if (typeof version !== 'string') return { ok: false };
  let current = version;
  let document = input;
  for (let hop = 0; hop < MIGRATIONS.length + 1; hop += 1) {
    if (current === target) return { ok: true, document, from: version };
    const step = MIGRATIONS.find((migration) => migration.from === current);
    if (step === undefined) return { ok: false };
    document = step.migrate(document);
    current = step.to;
  }
  return { ok: false };
}
