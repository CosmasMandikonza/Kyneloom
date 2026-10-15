import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  describeFixtureIndexError,
  parseFixtureIndex,
  type FixtureIndex,
} from '@kyneloom/contracts';

/**
 * Server-side fixture-loading seam (KYN-01).
 *
 * Reads the versioned test-harness fixture index so the future
 * synthetic-match generator (KYN-03) has a stable, typed way to supply data
 * to the web application. Only import this module from server contexts
 * (server components, route handlers, tests): it uses `node:fs`.
 *
 * Every failure mode returns a typed status — this loader never throws and
 * never fabricates fixture data, so a missing or malformed index renders an
 * intentional state instead of crashing the page.
 */

export type FixtureIndexStatus =
  | { readonly status: 'ok'; readonly index: FixtureIndex; readonly directory: string }
  | {
      readonly status: 'unavailable';
      readonly reason:
        'env-dir-missing' | 'workspace-root-not-found' | 'fixtures-dir-missing' | 'index-missing';
      readonly directory: string | null;
    }
  | { readonly status: 'invalid'; readonly message: string; readonly directory: string };

interface ResolvedDirectory {
  readonly directory: string | null;
  readonly reason?: 'env-dir-missing' | 'workspace-root-not-found' | 'fixtures-dir-missing';
}

/**
 * Locate the fixtures directory.
 *
 * Precedence: `KYNELOOM_FIXTURES_DIR` (absolute or relative to cwd), then
 * `<workspace root>/tests/fixtures` found by walking up from `startDir` to
 * the `pnpm-workspace.yaml` marker. Walking (instead of assuming a fixed
 * depth) keeps resolution correct when Next runs from `apps/web`, when tests
 * run from the repository root, and when the app is started from elsewhere.
 */
export function resolveFixturesDirectory(startDir: string = process.cwd()): ResolvedDirectory {
  const envDir = process.env['KYNELOOM_FIXTURES_DIR'];
  if (envDir !== undefined && envDir.trim() !== '') {
    const directory = path.resolve(envDir.trim());
    return existsSync(directory) ? { directory } : { directory: null, reason: 'env-dir-missing' };
  }

  // The walk-up resolves the workspace root at runtime; the turbopackIgnore
  // comment opts this resolver out of build-time output tracing, which would
  // otherwise pull the whole repository into the server bundle trace.
  let dir = path.resolve(/* turbopackIgnore: true */ startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const fixtures = path.join(dir, 'tests', 'fixtures');
      return existsSync(fixtures)
        ? { directory: fixtures }
        : { directory: null, reason: 'fixtures-dir-missing' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { directory: null, reason: 'workspace-root-not-found' };
    }
    dir = parent;
  }
}

/**
 * Load and validate the fixture index.
 *
 * The result is stable for a given directory contents, so the home page can
 * be statically prerendered at build time; production deployments pick up
 * fixture changes on rebuild (documented in the repository README).
 */
export function loadFixtureIndex(): FixtureIndexStatus {
  const resolved = resolveFixturesDirectory();
  if (resolved.directory === null) {
    return {
      status: 'unavailable',
      reason: resolved.reason ?? 'fixtures-dir-missing',
      directory: null,
    };
  }

  const indexPath = path.join(resolved.directory, 'index.json');
  if (!existsSync(indexPath)) {
    return { status: 'unavailable', reason: 'index-missing', directory: resolved.directory };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown;
  } catch (error) {
    return {
      status: 'invalid',
      message: `index.json is not valid JSON: ${(error as Error).message}`,
      directory: resolved.directory,
    };
  }

  const result = parseFixtureIndex(parsedJson);
  if (!result.ok) {
    return {
      status: 'invalid',
      message: describeFixtureIndexError(result.error),
      directory: resolved.directory,
    };
  }
  return { status: 'ok', index: result.index, directory: resolved.directory };
}
