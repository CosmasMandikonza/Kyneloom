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
export const MANIFEST_SCHEMA_VERSION = '0.1.0' as const;

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

/**
 * Registered version migrations. Empty today by design: the first breaking
 * change (e.g. manifest 0.1.0 → 0.2.0) adds an entry
 * `{ from, to, migrate(input: unknown): unknown }` plus corpus tests that
 * prove old fixtures survive the hop. Nothing may bypass this registry.
 */
export const MIGRATIONS: readonly unknown[] = [];
