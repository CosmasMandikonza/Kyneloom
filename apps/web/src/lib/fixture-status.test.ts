import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixtureIndexStatus } from './fixtures';
import { loadFixtureIndex } from './fixtures';
import {
  assertSummaryIsPathFree,
  describeFixtureStatus,
  fixtureDirectoryLabel,
} from './fixture-status';

/**
 * KYN-01 review fix: the rendered fixture seam must never expose absolute
 * filesystem paths — including when KYNELOOM_FIXTURES_DIR points outside the
 * workspace — while server-side logs keep the full diagnostic.
 */

const originalEnv = process.env['KYNELOOM_FIXTURES_DIR'];
const tempDirs: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kyneloom-status-'));
  tempDirs.push(dir);
  return dir;
}

function runWithOverrideDir<T>(dir: string, fn: () => T): T {
  process.env['KYNELOOM_FIXTURES_DIR'] = dir;
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) delete process.env['KYNELOOM_FIXTURES_DIR'];
    else process.env['KYNELOOM_FIXTURES_DIR'] = originalEnv;
  }
}

beforeEach(() => {
  delete process.env['KYNELOOM_FIXTURES_DIR'];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function allRenderedText(status: FixtureIndexStatus): string[] {
  const summary = describeFixtureStatus(status);
  return [summary.title, summary.detail, fixtureDirectoryLabel(status)];
}

const ABSOLUTE_PATTERNS: RegExp[] = [
  /[a-zA-Z]:[\\/]/, // Windows drive paths
  /\\\\/, // UNC paths
  /(?:^|\s)\/(?:home|Users|etc|var|tmp|private|AppData)\b/, // POSIX roots
  /temp\\kyneloom/i,
  /kyneloom-status-/i,
];

describe('describeFixtureStatus and fixtureDirectoryLabel (path-leak regression)', () => {
  it('renders the committed workspace state without any path', () => {
    const status = loadFixtureIndex();
    const texts = allRenderedText(status);
    for (const text of texts) {
      for (const pattern of ABSOLUTE_PATTERNS) {
        expect(text, `"${text}" must not match ${String(pattern)}`).not.toMatch(pattern);
      }
    }
    expect(texts.join(' ')).toContain('Valid index');
    expect(texts.join(' ')).toContain('tests/fixtures');
  });

  it('never leaks the override directory when KYNELOOM_FIXTURES_DIR points outside the workspace', () => {
    const outside = makeTempDir(); // absolute path outside the repository
    const status = runWithOverrideDir(outside, () => loadFixtureIndex());
    expect(status.status).toBe('unavailable'); // exists but has no index.json

    const texts = allRenderedText(status);
    for (const text of texts) {
      for (const pattern of ABSOLUTE_PATTERNS) {
        expect(text, `"${text}" must not match ${String(pattern)}`).not.toMatch(pattern);
      }
      expect(text).not.toContain(outside);
    }
    // The diagnostic with the absolute path goes to the server log instead.
    const logged = warnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logged).toContain(outside);
    // The rendered label identifies the override without its location.
    expect(fixtureDirectoryLabel(status)).toBe('KYNELOOM_FIXTURES_DIR override (index.json)');
  });

  it('never renders snippets embedded in a malformed JSON parse error', () => {
    const outside = makeTempDir();
    // Node JSON.parse errors can echo the first part of the rejected payload.
    writeFileSync(path.join(outside, 'index.json'), 'C:/Users/private-owner/secret.json');
    const status = runWithOverrideDir(outside, () => loadFixtureIndex());
    expect(status.status).toBe('invalid');
    if (status.status !== 'invalid') return;

    expect(status.message).toBe('index.json is not valid JSON');
    const summary = describeFixtureStatus(status);
    expect(summary.detail).not.toContain('C:/Users');
    expect(summary.detail).not.toContain(outside);
    expect(() => assertSummaryIsPathFree(summary)).not.toThrow();

    // Preserve full diagnostics in the server log only, not in rendered text.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.join(' ')).toContain('parse error:');
  });

  it('never leaks the directory for an invalid index loaded from outside the workspace', () => {
    const outside = makeTempDir();
    writeFileSync(path.join(outside, 'index.json'), '{broken');
    const status = runWithOverrideDir(outside, () => loadFixtureIndex());
    expect(status.status).toBe('invalid');

    const texts = allRenderedText(status);
    for (const text of texts) {
      expect(text).not.toContain(outside);
      for (const pattern of ABSOLUTE_PATTERNS) {
        expect(text, `"${text}" must not match ${String(pattern)}`).not.toMatch(pattern);
      }
    }
    const summary = describeFixtureStatus(status);
    expect(summary.detail).toContain('not valid JSON');
    expect(summary.detail).toContain('server log');
  });

  it('never leaks for an env directory that does not exist at all', () => {
    const ghost = path.join(makeTempDir(), 'missing-dir');
    const status = runWithOverrideDir(ghost, () => loadFixtureIndex());
    expect(status).toMatchObject({ status: 'unavailable', reason: 'env-dir-missing' });
    const texts = allRenderedText(status);
    for (const text of texts) {
      expect(text).not.toContain(ghost);
      expect(text).not.toMatch(/[a-zA-Z]:[\\/]/);
    }
  });

  it('produces summaries that satisfy the path-free assertion helper', () => {
    const statuses: FixtureIndexStatus[] = [
      {
        status: 'ok',
        index: { schemaVersion: '0.1', fixtures: [] },
        directory: 'C:\\absolute\\never\\rendered',
        source: 'workspace',
      },
      {
        status: 'unavailable',
        reason: 'workspace-root-not-found',
        directory: null,
        source: 'workspace',
      },
      {
        status: 'invalid',
        message: 'field "fixtures[0].file" is invalid: traversal rejected',
        directory: '/var/absolute/never/rendered',
        source: 'override',
      },
    ];
    for (const status of statuses) {
      expect(() => assertSummaryIsPathFree(describeFixtureStatus(status))).not.toThrow();
    }
  });

  it('the assertion helper itself catches path leaks (guards the guard)', () => {
    expect(() =>
      assertSummaryIsPathFree({
        tone: 'warn',
        title: 'Broken',
        detail: 'Looked in C:\\Users\\someone\\fixtures',
      }),
    ).toThrow(/path/);
  });
});

describe('fixtureDirectoryLabel', () => {
  it('names the workspace default explicitly', () => {
    expect(
      fixtureDirectoryLabel({
        status: 'ok',
        index: { schemaVersion: '0.1', fixtures: [] },
        directory: 'C:\\repo\\tests\\fixtures',
        source: 'workspace',
      }),
    ).toBe('tests/fixtures (index.json)');
  });

  it('returns a dash when nothing was resolved', () => {
    expect(
      fixtureDirectoryLabel({
        status: 'unavailable',
        reason: 'workspace-root-not-found',
        directory: null,
        source: 'workspace',
      }),
    ).toBe('—');
  });
});
