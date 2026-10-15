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
 *
 * Absolute paths (the resolved `directory`) are diagnostics for server logs
 * only; UI text must come from `fixture-status.ts`, which renders safe
 * labels without filesystem locations.
 */

/** Where the fixtures directory came from — drives safe UI labels. */
export type FixtureDirectorySource = 'workspace' | 'override';

export type FixtureUnavailableReason =
  'env-dir-missing' | 'workspace-root-not-found' | 'fixtures-dir-missing' | 'index-missing';

export type FixtureIndexStatus =
  | {
      readonly status: 'ok';
      readonly index: FixtureIndex;
      readonly directory: string;
      readonly source: FixtureDirectorySource;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: FixtureUnavailableReason;
      readonly directory: string | null;
      readonly source: FixtureDirectorySource;
    }
  | {
      readonly status: 'invalid';
      readonly message: string;
      readonly directory: string;
      readonly source: FixtureDirectorySource;
    };

interface ResolvedDirectory {
  readonly directory: string | null;
  readonly source: FixtureDirectorySource;
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
    return existsSync(directory)
      ? { directory, source: 'override' }
      : { directory: null, reason: 'env-dir-missing', source: 'override' };
  }

  // The walk-up resolves the workspace root at runtime; the turbopackIgnore
  // comment opts this resolver out of build-time output tracing, which would
  // otherwise pull the whole repository into the server bundle trace.
  let dir = path.resolve(/* turbopackIgnore: true */ startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const fixtures = path.join(dir, 'tests', 'fixtures');
      return existsSync(fixtures)
        ? { directory: fixtures, source: 'workspace' }
        : { directory: null, reason: 'fixtures-dir-missing', source: 'workspace' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return { directory: null, reason: 'workspace-root-not-found', source: 'workspace' };
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
 *
 * Degraded results are logged with their full absolute directory here —
 * server-side only — so operators keep useful diagnostics while the rendered
 * page never exposes filesystem locations.
 */
export function loadFixtureIndex(): FixtureIndexStatus {
  const resolved = resolveFixturesDirectory();
  if (resolved.directory === null) {
    const status: FixtureIndexStatus = {
      status: 'unavailable',
      reason: resolved.reason ?? 'fixtures-dir-missing',
      directory: null,
      source: resolved.source,
    };
    logServerDiagnostic(status);
    return status;
  }

  const indexPath = path.join(resolved.directory, 'index.json');
  if (!existsSync(indexPath)) {
    const status: FixtureIndexStatus = {
      status: 'unavailable',
      reason: 'index-missing',
      directory: resolved.directory,
      source: resolved.source,
    };
    logServerDiagnostic(status);
    return status;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown;
  } catch (error) {
    // JSON.parse error messages may quote snippets from the malformed input.
    // Never pass those snippets into UI-facing status strings.
    const status: FixtureIndexStatus = {
      status: 'invalid',
      message: 'index.json is not valid JSON',
      directory: resolved.directory,
      source: resolved.source,
    };
    logServerDiagnostic(status, error);
    return status;
  }

  const result = parseFixtureIndex(parsedJson);
  if (!result.ok) {
    const status: FixtureIndexStatus = {
      status: 'invalid',
      message: describeFixtureIndexError(result.error),
      directory: resolved.directory,
      source: resolved.source,
    };
    logServerDiagnostic(status);
    return status;
  }
  return {
    status: 'ok',
    index: result.index,
    directory: resolved.directory,
    source: resolved.source,
  };
}

function logServerDiagnostic(
  status: Exclude<FixtureIndexStatus, { status: 'ok' }>,
  cause?: unknown,
): void {
  const where =
    status.directory === null
      ? '(no directory resolved)'
      : `${status.directory} via ${status.source === 'override' ? 'KYNELOOM_FIXTURES_DIR' : 'workspace walk-up'}`;
  const why =
    status.status === 'unavailable' ? `reason=${status.reason}` : `message=${status.message}`;
  const internalDetail =
    cause === undefined ? '' : `; parse error: ${cause instanceof Error ? cause.message : String(cause)}`;
  // The diagnostic goes to the server log only; the UI receives the sanitized status.message.
  console.warn(`[kyneloom:fixtures] fixture index degraded: ${why}; looked in ${where}${internalDetail}`);
}
