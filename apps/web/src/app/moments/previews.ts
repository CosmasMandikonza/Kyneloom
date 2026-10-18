import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * KYN-10 preview provenance (server-side), review round 2.
 *
 * Two strictly separated stages:
 *
 * 1. `loadPreviewBook()` — bounded, throw-free RAW load of the manifest
 *    written by the offline capture pipeline. It shape-checks records,
 *    rejects unsafe filenames BEFORE any filesystem use (traversal and
 *    non-image extensions never reach `path.join`), keeps duplicate
 *    catalogIds as-is for the binder to rule on, and retains the
 *    manifest's fixture fingerprint. Nothing here decides whether a
 *    preview is TRUSTWORTHY for display.
 *
 * 2. `bindPreviewBook()` — fail-closed binding of the raw records to the
 *    AUTHORITATIVE catalog + fixture being rendered. A preview renders
 *    only when the manifest's match id, seed, generator version and
 *    content hashes match the current fixture, the record's catalogId
 *    exists in the catalog, its focusMs and camera equal that chapter's
 *    validated values, and (for the featured motion) the interval starts
 *    at the featured focus and stays inside the window with the featured
 *    camera. Anything else drops to the existing honest
 *    preview-unavailable state; card navigation is unaffected.
 */

export interface PreviewRecord {
  readonly catalogId: string;
  readonly src: string;
  readonly focusMs: number;
  readonly camera: string;
  readonly width: number;
  readonly height: number;
}

export interface MotionRecord {
  readonly catalogId: string;
  readonly src: string;
  readonly poster: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly camera: string;
}

/** The manifest's own claim about which fixture produced its images. */
export interface PreviewFixtureFingerprint {
  readonly matchId: string;
  readonly seed: number | null;
  readonly generatorVersion: string | null;
  readonly eventsSha256: string | null;
  readonly trackingSha256: string | null;
}

/** Loader output: untrusted raw records + the manifest's fingerprint claim. */
export interface RawPreviewBook {
  readonly records: readonly PreviewRecord[];
  readonly motion: MotionRecord | null;
  readonly fingerprint: PreviewFixtureFingerprint | null;
  /** Pipeline method string from the manifest (documented provenance). */
  readonly method: string | null;
  readonly generatedAt: string | null;
}

/** Binder output: only records that match the authoritative truth. */
export interface PreviewBook {
  readonly byId: ReadonlyMap<string, PreviewRecord>;
  readonly motion: MotionRecord | null;
  readonly method: string | null;
  readonly generatedAt: string | null;
}

export const EMPTY_PREVIEW_BOOK: PreviewBook = {
  byId: new Map(),
  motion: null,
  method: null,
  generatedAt: null,
};

/** The authoritative fixture a preview must be bound to. */
export interface PreviewFixtureBinding {
  readonly matchId: string;
  readonly seed: number;
  readonly generatorVersion: string;
  readonly eventsSha256: string | null;
  readonly trackingSha256: string | null;
}

/** The authoritative catalog a preview must be bound to. */
export interface PreviewCatalogBinding {
  /** featured + chapters, keyed by catalog id. */
  readonly entries: ReadonlyMap<string, { readonly focusMs: number; readonly camera: string }>;
  readonly featuredId: string;
  readonly windowMs: readonly [number, number];
}

/**
 * Safe preview filenames: a bare basename of the pipeline's own naming
 * (kebab id + png for stills, mp4 for the motion clip). No separators, no
 * '..', no drives, no query/tricks — checked BEFORE any path use.
 */
const SAFE_PREVIEW_FILE = /^[a-z0-9][a-z0-9-]*\.(png|mp4)$/;

export function isSafePreviewFilename(file: unknown): file is string {
  return typeof file === 'string' && SAFE_PREVIEW_FILE.test(file) && path.basename(file) === file;
}

function resolvePreviewsDirectory(): string | null {
  const candidates: string[] = [path.join(process.cwd(), 'public', 'moment-previews')];
  // Tests and repo-root invocations: walk up to the workspace marker.
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      candidates.push(path.join(dir, 'apps', 'web', 'public', 'moment-previews'));
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const EMPTY_RAW_BOOK: RawPreviewBook = {
  records: [],
  motion: null,
  fingerprint: null,
  method: null,
  generatedAt: null,
};

export function loadPreviewBook(): RawPreviewBook {
  const directory = resolvePreviewsDirectory();
  if (directory === null) return EMPTY_RAW_BOOK;
  const manifestPath = path.join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) return EMPTY_RAW_BOOK;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch {
    return EMPTY_RAW_BOOK;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_RAW_BOOK;
  const record = parsed as Record<string, unknown>;
  const previewsRaw = record['previews'];
  if (!Array.isArray(previewsRaw)) return EMPTY_RAW_BOOK;

  const records: PreviewRecord[] = [];
  for (const raw of previewsRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['catalogId'] !== 'string') continue;
    if (!isSafePreviewFilename(entry['file'])) continue; // unsafe name: never touch the fs
    if (!isFiniteNumber(entry['focusMs']) || typeof entry['camera'] !== 'string') continue;
    if (
      !isFiniteNumber(entry['width']) ||
      !isFiniteNumber(entry['height']) ||
      entry['width'] <= 0 ||
      entry['height'] <= 0 ||
      entry['width'] > 8192 ||
      entry['height'] > 8192
    ) {
      continue;
    }
    if (!existsSync(path.join(directory, entry['file']))) continue; // honest absence
    records.push({
      catalogId: entry['catalogId'],
      src: `/moment-previews/${entry['file']}`,
      focusMs: entry['focusMs'],
      camera: entry['camera'],
      width: entry['width'],
      height: entry['height'],
    });
  }

  let motion: MotionRecord | null = null;
  const motionRaw = record['motion'];
  if (typeof motionRaw === 'object' && motionRaw !== null) {
    const entry = motionRaw as Record<string, unknown>;
    if (
      isSafePreviewFilename(entry['file']) &&
      isSafePreviewFilename(entry['poster']) &&
      isFiniteNumber(entry['fromMs']) &&
      isFiniteNumber(entry['toMs']) &&
      typeof entry['camera'] === 'string' &&
      existsSync(path.join(directory, entry['file'])) &&
      existsSync(path.join(directory, entry['poster']))
    ) {
      motion = {
        catalogId: typeof entry['catalogId'] === 'string' ? entry['catalogId'] : '',
        src: `/moment-previews/${entry['file']}`,
        poster: `/moment-previews/${entry['poster']}`,
        fromMs: entry['fromMs'],
        toMs: entry['toMs'],
        camera: entry['camera'],
      };
    }
  }

  const fixtureRaw = record['fixture'];
  const fingerprint: PreviewFixtureFingerprint | null =
    typeof fixtureRaw === 'object' && fixtureRaw !== null
      ? {
          matchId: typeof record['matchId'] === 'string' ? record['matchId'] : '',
          seed: isFiniteNumber((fixtureRaw as Record<string, unknown>)['seed'])
            ? ((fixtureRaw as Record<string, unknown>)['seed'] as number)
            : null,
          generatorVersion:
            typeof (fixtureRaw as Record<string, unknown>)['generatorVersion'] === 'string'
              ? ((fixtureRaw as Record<string, unknown>)['generatorVersion'] as string)
              : null,
          eventsSha256:
            typeof (fixtureRaw as Record<string, unknown>)['eventsSha256'] === 'string'
              ? ((fixtureRaw as Record<string, unknown>)['eventsSha256'] as string)
              : null,
          trackingSha256:
            typeof (fixtureRaw as Record<string, unknown>)['trackingSha256'] === 'string'
              ? ((fixtureRaw as Record<string, unknown>)['trackingSha256'] as string)
              : null,
        }
      : null;

  return {
    records,
    motion,
    fingerprint,
    method: typeof record['method'] === 'string' ? record['method'] : null,
    generatedAt: typeof record['generatedAt'] === 'string' ? record['generatedAt'] : null,
  };
}

/**
 * Fixture-level gate: the manifest must describe THIS fixture. Seed and
 * generator version are the deterministic revision fingerprint; when either
 * side carries content hashes they must agree too. Any mismatch means every
 * image's provenance is untrustworthy → the whole book is withheld.
 */
function fixtureFingerprintMatches(
  claimed: PreviewFixtureFingerprint,
  authoritative: PreviewFixtureBinding,
): boolean {
  if (claimed.matchId !== authoritative.matchId) return false;
  if (claimed.seed === null || claimed.seed !== authoritative.seed) return false;
  if (
    claimed.generatorVersion === null ||
    claimed.generatorVersion !== authoritative.generatorVersion
  ) {
    return false;
  }
  if (authoritative.eventsSha256 !== null && claimed.eventsSha256 !== authoritative.eventsSha256) {
    return false;
  }
  if (
    authoritative.trackingSha256 !== null &&
    claimed.trackingSha256 !== authoritative.trackingSha256
  ) {
    return false;
  }
  return true;
}

/**
 * Fail-closed binding of raw manifest records to the authoritative catalog
 * and fixture. Returns the renderable book: only records whose id, exact
 * timestamp and camera match the catalog entry they will be displayed
 * against, with duplicates (ambiguous provenance) dropped entirely.
 */
export function bindPreviewBook(
  raw: RawPreviewBook,
  fixture: PreviewFixtureBinding,
  catalog: PreviewCatalogBinding,
): PreviewBook {
  if (raw.fingerprint === null || !fixtureFingerprintMatches(raw.fingerprint, fixture)) {
    return EMPTY_PREVIEW_BOOK;
  }

  const byId = new Map<string, PreviewRecord>();
  const seen = new Map<string, number>();
  for (const record of raw.records) {
    seen.set(record.catalogId, (seen.get(record.catalogId) ?? 0) + 1);
  }
  for (const record of raw.records) {
    const entry = catalog.entries.get(record.catalogId);
    if (entry === undefined) continue; // not part of the rendered catalog
    if ((seen.get(record.catalogId) ?? 0) !== 1) continue; // duplicate id: ambiguous
    if (record.focusMs !== entry.focusMs) continue; // wrong instant
    if (record.camera !== entry.camera) continue; // wrong framing
    byId.set(record.catalogId, record);
  }

  let motion: MotionRecord | null = null;
  const featured = catalog.entries.get(catalog.featuredId);
  const rawMotion = raw.motion;
  if (
    rawMotion !== null &&
    featured !== undefined &&
    rawMotion.catalogId === catalog.featuredId &&
    rawMotion.fromMs === featured.focusMs &&
    rawMotion.toMs > rawMotion.fromMs &&
    rawMotion.toMs <= catalog.windowMs[1] &&
    rawMotion.fromMs >= catalog.windowMs[0] &&
    rawMotion.camera === featured.camera &&
    rawMotion.poster === `/moment-previews/${catalog.featuredId}.png`
  ) {
    motion = rawMotion;
  }

  return { byId, motion, method: raw.method, generatedAt: raw.generatedAt };
}
