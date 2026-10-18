import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * KYN-10 preview provenance book (server-side).
 *
 * Reads the manifest written by the offline preview pipeline
 * (`scripts/generate-moment-previews.ts` → `pnpm moments:previews`), which
 * captures REAL frames of the actual Living Replay renderer at each
 * chapter's validated timestamp. Every preview carries its source match id,
 * timestamp, render camera and generation method; a preview whose file is
 * missing from `public/moment-previews` is simply absent here — cards then
 * render the honest "preview unavailable" state while remaining fully
 * navigable.
 *
 * This loader never throws: a missing/invalid manifest degrades to an empty
 * book and the gallery stays truthful about what exists.
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

export interface PreviewBook {
  readonly byId: ReadonlyMap<string, PreviewRecord>;
  readonly motion: MotionRecord | null;
  /** Pipeline method string from the manifest (documented provenance). */
  readonly method: string | null;
  readonly generatedAt: string | null;
}

const EMPTY_BOOK: PreviewBook = { byId: new Map(), motion: null, method: null, generatedAt: null };

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

export function loadPreviewBook(): PreviewBook {
  const directory = resolvePreviewsDirectory();
  if (directory === null) return EMPTY_BOOK;
  const manifestPath = path.join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) return EMPTY_BOOK;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  } catch {
    return EMPTY_BOOK;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_BOOK;
  const record = parsed as Record<string, unknown>;
  const previewsRaw = record['previews'];
  if (!Array.isArray(previewsRaw)) return EMPTY_BOOK;

  const byId = new Map<string, PreviewRecord>();
  for (const raw of previewsRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['catalogId'] !== 'string' || typeof entry['file'] !== 'string') continue;
    if (!isFiniteNumber(entry['focusMs']) || typeof entry['camera'] !== 'string') continue;
    if (!isFiniteNumber(entry['width']) || !isFiniteNumber(entry['height'])) continue;
    const file = path.join(directory, entry['file']);
    if (!existsSync(file)) continue; // honest absence — never a dead src
    byId.set(entry['catalogId'], {
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
      typeof entry['file'] === 'string' &&
      typeof entry['poster'] === 'string' &&
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

  return {
    byId,
    motion,
    method: typeof record['method'] === 'string' ? record['method'] : null,
    generatedAt: typeof record['generatedAt'] === 'string' ? record['generatedAt'] : null,
  };
}
