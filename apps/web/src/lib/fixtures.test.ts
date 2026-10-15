import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFixtureIndex, resolveFixturesDirectory } from './fixtures';

const originalEnv = process.env['KYNELOOM_FIXTURES_DIR'];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kyneloom-fixtures-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env['KYNELOOM_FIXTURES_DIR'];
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env['KYNELOOM_FIXTURES_DIR'];
  } else {
    process.env['KYNELOOM_FIXTURES_DIR'] = originalEnv;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveFixturesDirectory', () => {
  it('finds the committed fixtures directory by walking up to the workspace root', () => {
    // Vitest runs from the repository root; resolve from a nested path to
    // prove the walk-up works from any depth.
    const resolved = resolveFixturesDirectory(path.join(process.cwd(), 'apps', 'web', 'src'));
    expect(resolved.directory).toBe(path.join(process.cwd(), 'tests', 'fixtures'));
    expect(resolved.reason).toBeUndefined();
  });

  it('reports a missing workspace root instead of looping forever', () => {
    const resolved = resolveFixturesDirectory(tmpdir());
    expect(resolved).toEqual({ directory: null, reason: 'workspace-root-not-found' });
  });

  it('honors KYNELOOM_FIXTURES_DIR when it exists', () => {
    const dir = makeTempDir();
    process.env['KYNELOOM_FIXTURES_DIR'] = dir;
    expect(resolveFixturesDirectory()).toEqual({ directory: dir });
  });

  it('reports env-dir-missing when KYNELOOM_FIXTURES_DIR points nowhere', () => {
    process.env['KYNELOOM_FIXTURES_DIR'] = path.join(makeTempDir(), 'does-not-exist');
    expect(resolveFixturesDirectory()).toEqual({
      directory: null,
      reason: 'env-dir-missing',
    });
  });

  it('reports fixtures-dir-missing when the workspace root has no tests/fixtures', () => {
    const fakeRoot = makeTempDir();
    writeFileSync(path.join(fakeRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveFixturesDirectory(fakeRoot)).toEqual({
      directory: null,
      reason: 'fixtures-dir-missing',
    });
  });

  it('resolves a workspace-shaped directory tree from a nested start', () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nested = path.join(root, 'apps', 'web');
    mkdirSync(nested, { recursive: true });
    const fixtures = path.join(root, 'tests', 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    expect(resolveFixturesDirectory(nested)).toEqual({ directory: fixtures });
  });
});

describe('loadFixtureIndex', () => {
  it('loads the committed empty index as a valid intentional state', () => {
    const status = loadFixtureIndex();
    expect(status).toMatchObject({
      status: 'ok',
      directory: path.join(process.cwd(), 'tests', 'fixtures'),
    });
    if (status.status !== 'ok') return;
    expect(status.index.schemaVersion).toBe('0.1');
    expect(status.index.fixtures).toEqual([]);
  });

  it('loads a populated index from an override directory', () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        fixtures: [
          {
            id: 'synthetic-derby-01',
            label: 'Synthetic derby',
            generator: 'fixture-engine-v1',
            seed: 24017,
            file: 'synthetic-derby-01.json',
          },
        ],
      }),
    );
    process.env['KYNELOOM_FIXTURES_DIR'] = dir;
    const status = loadFixtureIndex();
    expect(status.status).toBe('ok');
    if (status.status !== 'ok') return;
    expect(status.index.fixtures).toHaveLength(1);
    expect(status.index.fixtures[0]?.id).toBe('synthetic-derby-01');
  });

  it('returns unavailable with a reason when the index file is absent', () => {
    process.env['KYNELOOM_FIXTURES_DIR'] = makeTempDir();
    expect(loadFixtureIndex()).toMatchObject({ status: 'unavailable', reason: 'index-missing' });
  });

  it('returns invalid (not a crash) for malformed JSON', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'index.json'), '{not json');
    process.env['KYNELOOM_FIXTURES_DIR'] = dir;
    const status = loadFixtureIndex();
    expect(status.status).toBe('invalid');
    if (status.status !== 'invalid') return;
    expect(status.message).toContain('not valid JSON');
  });

  it('returns invalid for schema violations caught by the contracts parser', () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({ schemaVersion: '0.1', fixtures: 'nope' }),
    );
    process.env['KYNELOOM_FIXTURES_DIR'] = dir;
    const status = loadFixtureIndex();
    expect(status.status).toBe('invalid');
    if (status.status !== 'invalid') return;
    expect(status.message).toContain('fixtures');
  });

  it('returns unavailable when the env directory does not exist', () => {
    process.env['KYNELOOM_FIXTURES_DIR'] = path.join(makeTempDir(), 'missing');
    expect(loadFixtureIndex()).toMatchObject({
      status: 'unavailable',
      reason: 'env-dir-missing',
      directory: null,
    });
  });
});
