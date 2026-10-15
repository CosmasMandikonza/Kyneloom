import { describe, expect, it } from 'vitest';
import {
  FIXTURE_INDEX_SCHEMA_VERSION,
  describeFixtureIndexError,
  parseFixtureIndex,
} from './fixture-index';

const validIndex = {
  schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
  fixtures: [
    {
      id: 'synthetic-derby-01',
      label: 'Synthetic derby — first vertical slice',
      generator: 'fixture-engine-v1',
      seed: 24017,
      file: 'synthetic-derby-01.json',
    },
  ],
};

describe('parseFixtureIndex', () => {
  it('accepts a valid index and preserves fixture entries', () => {
    const result = parseFixtureIndex(validIndex);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.schemaVersion).toBe(FIXTURE_INDEX_SCHEMA_VERSION);
    expect(result.index.fixtures).toHaveLength(1);
    expect(result.index.fixtures[0]).toEqual({
      id: 'synthetic-derby-01',
      label: 'Synthetic derby — first vertical slice',
      generator: 'fixture-engine-v1',
      seed: 24017,
      file: 'synthetic-derby-01.json',
    });
  });

  it('accepts an empty fixtures array (intentional "no fixture data" state)', () => {
    const result = parseFixtureIndex({ schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION, fixtures: [] });
    expect(result).toEqual({
      ok: true,
      index: { schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION, fixtures: [] },
    });
  });

  it('rejects non-object input', () => {
    for (const input of [null, undefined, 'nope', 42, [], true]) {
      expect(parseFixtureIndex(input)).toEqual({ ok: false, error: { kind: 'not-an-object' } });
    }
  });

  it('rejects missing schemaVersion and fixtures fields', () => {
    expect(parseFixtureIndex({ fixtures: [] })).toEqual({
      ok: false,
      error: { kind: 'missing-field', field: 'schemaVersion' },
    });
    expect(parseFixtureIndex({ schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION })).toEqual({
      ok: false,
      error: { kind: 'missing-field', field: 'fixtures' },
    });
  });

  it('rejects unsupported schema versions with the found and expected versions', () => {
    const result = parseFixtureIndex({ schemaVersion: '9.9', fixtures: [] });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'unsupported-schema-version',
        found: '9.9',
        expectedMajorMinor: FIXTURE_INDEX_SCHEMA_VERSION,
      },
    });
  });

  it('rejects a malformed schemaVersion string', () => {
    const result = parseFixtureIndex({ schemaVersion: 'one-dot-one', fixtures: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      kind: 'invalid-field',
      field: 'schemaVersion',
      reason: 'must be "major.minor"',
    });
  });

  it('rejects a non-array fixtures field', () => {
    const result = parseFixtureIndex({
      schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
      fixtures: 'all of them',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'invalid-field', field: 'fixtures' });
  });

  it('rejects entries with malformed ids', () => {
    for (const id of ['Bad-ID', 'spaces in id', '', 'id/slash', '_leading-underscore']) {
      const result = parseFixtureIndex({
        schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
        fixtures: [{ ...validIndex.fixtures[0], id }],
      });
      expect(result.ok, `id "${id}" should be rejected`).toBe(false);
    }
  });

  it('rejects non-finite, negative, and non-integer seeds', () => {
    for (const seed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '24017']) {
      const result = parseFixtureIndex({
        schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
        fixtures: [{ ...validIndex.fixtures[0], seed }],
      });
      expect(result.ok, `seed ${String(seed)} should be rejected`).toBe(false);
    }
  });

  it('rejects absolute and traversing file paths', () => {
    for (const file of [
      '/etc/passwd',
      '../outside.json',
      'C:\\windows\\escape.json',
      '\\rooted.json',
    ]) {
      const result = parseFixtureIndex({
        schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
        fixtures: [{ ...validIndex.fixtures[0], file }],
      });
      expect(result.ok, `file "${file}" should be rejected`).toBe(false);
    }
  });

  it('rejects Windows backslash traversal and backslash separators', () => {
    for (const file of [
      'folder\\..\\secret.json',
      '..\\secret.json',
      'legit\\subfolder\\fixture.json',
      'trailing\\',
    ]) {
      const result = parseFixtureIndex({
        schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
        fixtures: [{ ...validIndex.fixtures[0], file }],
      });
      expect(result.ok, `file "${file}" should be rejected`).toBe(false);
    }
  });

  it('rejects forward-slash drive prefixes, dot segments, empty segments, and control characters', () => {
    for (const file of [
      'C:/fixtures/escape.json',
      'c:/x.json',
      './relative.json',
      'a/./b.json',
      'a//b.json',
      'nested/ok/../secret.json',
      'nested/',
      'bad\u0000name.json',
      'bad\u001fname.json',
    ]) {
      const result = parseFixtureIndex({
        schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
        fixtures: [{ ...validIndex.fixtures[0], file }],
      });
      expect(result.ok, `file "${JSON.stringify(file)}" should be rejected`).toBe(false);
    }
  });

  it('accepts canonical nested forward-slash relative paths', () => {
    const result = parseFixtureIndex({
      schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
      fixtures: [
        { ...validIndex.fixtures[0], file: 'nested/folders/fixture-01.json' },
        { ...validIndex.fixtures[0], id: 'another-fixture', file: 'fixture-02.v2.json' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.fixtures[0]?.file).toBe('nested/folders/fixture-01.json');
    expect(result.index.fixtures[1]?.file).toBe('fixture-02.v2.json');
  });

  it('rejects duplicate fixture ids', () => {
    const result = parseFixtureIndex({
      schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
      fixtures: [validIndex.fixtures[0], validIndex.fixtures[0]],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: 'invalid-field',
      field: 'fixtures[1].id',
      reason: expect.stringContaining('duplicate'),
    });
  });

  it('rejects non-object entries', () => {
    const result = parseFixtureIndex({
      schemaVersion: FIXTURE_INDEX_SCHEMA_VERSION,
      fixtures: ['not-an-entry'],
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-field', field: 'fixtures[0]', reason: 'entry must be an object' },
    });
  });

  it('never throws for arbitrary JSON shapes', () => {
    expect(() => parseFixtureIndex({ schemaVersion: [], fixtures: [{ id: [] }] })).not.toThrow();
  });
});

describe('describeFixtureIndexError', () => {
  it('produces a non-empty message for every error kind', () => {
    const errors = [
      { kind: 'not-an-object' },
      { kind: 'missing-field', field: 'schemaVersion' },
      { kind: 'invalid-field', field: 'fixtures[0].id', reason: 'must match' },
      { kind: 'unsupported-schema-version', found: '9.9', expectedMajorMinor: '0.1' },
    ] as const;
    for (const error of errors) {
      expect(describeFixtureIndexError(error).length).toBeGreaterThan(0);
    }
  });
});
