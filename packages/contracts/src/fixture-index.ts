/**
 * Versioned test-harness fixture index.
 *
 * SCOPE — read before extending:
 * This module describes *test-only fixture metadata*: how the future
 * synthetic-match generator registers fixture files so the web application
 * can discover them. It is intentionally NOT the canonical football data
 * contract. `MatchEvent`, `TrackingSample`, and `MomentManifest` schemas are
 * jointly finalized in KYN-02 (docs/05-data-and-event-contracts.md,
 * docs/06-moment-manifest.md) and must not be invented here.
 */

/** Major.minor version of the fixture-index format understood by this code. */
export const FIXTURE_INDEX_SCHEMA_VERSION = '0.1' as const;

/**
 * One registered synthetic fixture. `file` points at a fixture payload the
 * generator will produce; the payload format itself is owned by KYN-02/KYN-03.
 */
export interface FixtureEntry {
  /** Stable identifier, e.g. "synthetic-derby-01". Lowercase letters, digits, hyphens. */
  readonly id: string;
  /** Human-readable label shown in developer surfaces. */
  readonly label: string;
  /** Name and version of the generator that produced the fixture. */
  readonly generator: string;
  /** Deterministic seed the fixture was generated from. */
  readonly seed: number;
  /** Path relative to the fixtures directory. Relative, no "..", no leading slash. */
  readonly file: string;
}

/** The parsed contents of `tests/fixtures/index.json`. */
export interface FixtureIndex {
  readonly schemaVersion: string;
  readonly fixtures: readonly FixtureEntry[];
}

export type FixtureIndexError =
  | { readonly kind: 'not-an-object' }
  | { readonly kind: 'missing-field'; readonly field: string }
  | { readonly kind: 'invalid-field'; readonly field: string; readonly reason: string }
  | {
      readonly kind: 'unsupported-schema-version';
      readonly found: string;
      readonly expectedMajorMinor: string;
    };

export type FixtureIndexResult =
  | { readonly ok: true; readonly index: FixtureIndex }
  | { readonly ok: false; readonly error: FixtureIndexError };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fixture files must be canonical, portable relative paths: forward-slash
 * separators only, no absolute form (POSIX root, UNC root, or drive letter),
 * no `..`/`.`/empty segments, and no control characters. Backslashes are
 * rejected outright so that Windows-style traversal such as
 * `folder\..\secret.json` can never smuggle a `..` segment past a
 * forward-slash-only split.
 */
function isUnsafeRelativePath(p: string): boolean {
  if (p.length === 0) return true;
  if (p.includes('\\')) return true;
  if (p.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(p)) return true;
  // Control characters are invalid in fixture paths; checked by code point
  // instead of a control-character regex so no lint suppression is needed.
  if (
    [...p].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return true;
  }
  const segments = p.split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function parseEntry(value: unknown, position: number): FixtureEntry | FixtureIndexError {
  if (!isRecord(value)) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}]`,
      reason: 'entry must be an object',
    };
  }
  const { id, label, generator, seed, file } = value;

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}].id`,
      reason: 'must match ^[a-z0-9][a-z0-9-]*$',
    };
  }
  if (typeof label !== 'string' || label.trim().length === 0) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}].label`,
      reason: 'must be a non-empty string',
    };
  }
  if (typeof generator !== 'string' || generator.trim().length === 0) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}].generator`,
      reason: 'must be a non-empty string naming the generator and version',
    };
  }
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}].seed`,
      reason: 'must be a non-negative safe integer',
    };
  }
  if (typeof file !== 'string' || file.length === 0 || isUnsafeRelativePath(file)) {
    return {
      kind: 'invalid-field',
      field: `fixtures[${position}].file`,
      reason:
        'must be a relative forward-slash path inside the fixtures directory without absolute prefixes or ".."/"."/empty segments',
    };
  }

  return { id, label, generator, seed, file };
}

/**
 * Parse and validate a fixture index from untrusted JSON input.
 * Rejects unknown schema major.minor versions, malformed identifiers,
 * non-finite seeds, and unsafe file paths. Never throws.
 */
export function parseFixtureIndex(input: unknown): FixtureIndexResult {
  if (!isRecord(input)) {
    return { ok: false, error: { kind: 'not-an-object' } };
  }

  const schemaVersion = input['schemaVersion'];
  if (schemaVersion === undefined) {
    return { ok: false, error: { kind: 'missing-field', field: 'schemaVersion' } };
  }
  if (typeof schemaVersion !== 'string' || !/^\d+\.\d+$/.test(schemaVersion)) {
    return {
      ok: false,
      error: { kind: 'invalid-field', field: 'schemaVersion', reason: 'must be "major.minor"' },
    };
  }
  if (schemaVersion !== FIXTURE_INDEX_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'unsupported-schema-version',
        found: schemaVersion,
        expectedMajorMinor: FIXTURE_INDEX_SCHEMA_VERSION,
      },
    };
  }

  const fixturesValue = input['fixtures'];
  if (fixturesValue === undefined) {
    return { ok: false, error: { kind: 'missing-field', field: 'fixtures' } };
  }
  if (!Array.isArray(fixturesValue)) {
    return {
      ok: false,
      error: { kind: 'invalid-field', field: 'fixtures', reason: 'must be an array' },
    };
  }

  const fixtures: FixtureEntry[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < fixturesValue.length; i++) {
    const parsed = parseEntry(fixturesValue[i], i);
    if ('kind' in parsed) {
      return { ok: false, error: parsed };
    }
    if (seenIds.has(parsed.id)) {
      return {
        ok: false,
        error: {
          kind: 'invalid-field',
          field: `fixtures[${i}].id`,
          reason: `duplicate id "${parsed.id}"`,
        },
      };
    }
    seenIds.add(parsed.id);
    fixtures.push(parsed);
  }

  return { ok: true, index: { schemaVersion, fixtures } };
}

/** Human-readable summary of a {@link FixtureIndexError} for logs and UI states. */
export function describeFixtureIndexError(error: FixtureIndexError): string {
  switch (error.kind) {
    case 'not-an-object':
      return 'fixture index must be a JSON object';
    case 'missing-field':
      return `missing required field "${error.field}"`;
    case 'invalid-field':
      return `field "${error.field}" is invalid: ${error.reason}`;
    case 'unsupported-schema-version':
      return `fixture index schema version ${error.found} is not supported (expected ${error.expectedMajorMinor})`;
  }
}
