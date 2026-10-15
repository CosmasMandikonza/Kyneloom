import type { FixtureIndexStatus, FixtureUnavailableReason } from './fixtures';

/**
 * Pure mapping from a fixture-index status to user-facing text.
 *
 * This module is the single place that decides what the fixture seam shows,
 * and it is regression-tested to never emit absolute filesystem paths: the
 * loader's `directory` field is server-side diagnostic data only. Full
 * diagnostics (including the resolved directory) are logged server-side by
 * `loadFixtureIndex`.
 */

export interface FixtureSummary {
  readonly tone: 'ok' | 'warn';
  readonly title: string;
  readonly detail: string;
}

/** True when the text contains anything resembling an absolute filesystem path. */
function looksAbsolute(text: string): boolean {
  return text.includes(':\\') || text.includes(':/') || text.startsWith('/') || text.includes('\\');
}

const REASON_TEXT: Record<FixtureUnavailableReason, string> = {
  'env-dir-missing': 'KYNELOOM_FIXTURES_DIR is set but points to a directory that does not exist.',
  'workspace-root-not-found':
    'the fixtures directory could not be located because no workspace root was found above the working directory.',
  'fixtures-dir-missing': 'the workspace has no tests/fixtures directory.',
  'index-missing': 'the fixtures directory exists but contains no index.json.',
};

export function describeFixtureStatus(status: FixtureIndexStatus): FixtureSummary {
  switch (status.status) {
    case 'ok':
      return {
        tone: 'ok',
        title: `Valid index · schema ${status.index.schemaVersion} · ${status.index.fixtures.length} fixture${status.index.fixtures.length === 1 ? '' : 's'} registered`,
        detail:
          status.index.fixtures.length === 0
            ? 'No synthetic match data exists yet. This is the intentional empty state — the seeded fixture generator (KYN-03) will register payloads here.'
            : 'Registered test-harness fixtures are listed below.',
      };
    case 'unavailable':
      return {
        tone: 'warn',
        title: 'Fixture index unavailable',
        detail: `${REASON_TEXT[status.reason]} The page continues without fixture data; nothing is fabricated. Details are in the server log.`,
      };
    case 'invalid':
      return {
        tone: 'warn',
        title: 'Fixture index invalid',
        detail: `${status.message} The page continues without fixture data; nothing is fabricated. Details are in the server log.`,
      };
  }
}

/**
 * Human label for the fixtures directory. Never returns an absolute path:
 * the workspace default is named explicitly, and overrides are described
 * without their location.
 */
export function fixtureDirectoryLabel(status: FixtureIndexStatus): string {
  if (status.status === 'unavailable' && status.directory === null) {
    return '—';
  }
  return status.source === 'workspace'
    ? 'tests/fixtures (index.json)'
    : 'KYNELOOM_FIXTURES_DIR override (index.json)';
}

/** Assertion helper used by tests: every rendered string must be path-free. */
export function assertSummaryIsPathFree(summary: FixtureSummary): void {
  for (const text of [summary.title, summary.detail]) {
    if (looksAbsolute(text)) {
      throw new Error(`fixture status text leaks a filesystem path: "${text}"`);
    }
  }
}
