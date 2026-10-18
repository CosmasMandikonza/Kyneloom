import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildMomentCatalog } from '@/lib/moment-catalog';
import {
  bindPreviewBook,
  isSafePreviewFilename,
  loadPreviewBook,
  EMPTY_PREVIEW_BOOK,
  type PreviewCatalogBinding,
  type PreviewFixtureBinding,
  type RawPreviewBook,
} from './previews';

/**
 * KYN-10 review round 2 — preview binding truth tests. A committed preview
 * may only render when its manifest is bound to the AUTHORITATIVE fixture
 * (match id, seed, generator version, content hashes) and the AUTHORITATIVE
 * catalog entry (exact timestamp + camera). Everything else must degrade to
 * the honest unavailable state without touching card navigation.
 */

async function bindings() {
  const golden = await loadGoldenMatch();
  if (!golden.ok) throw new Error('fixture unavailable');
  const catalog = buildMomentCatalog(golden);
  if (catalog === null) throw new Error('catalog null');
  const entries = new Map<string, { focusMs: number; camera: string }>();
  for (const entry of [catalog.featured, ...catalog.chapters]) {
    entries.set(entry.catalogId, { focusMs: entry.focusMs, camera: entry.previewCamera });
  }
  const fixture: PreviewFixtureBinding = {
    matchId: golden.data.matchId,
    seed: golden.data.seed,
    generatorVersion: golden.data.generatorVersion,
    eventsSha256: golden.data.integrity?.events ?? null,
    trackingSha256: golden.data.integrity?.tracking ?? null,
  };
  const catalogBinding: PreviewCatalogBinding = {
    entries,
    featuredId: catalog.featured.catalogId,
    windowMs: catalog.windowMs,
  };
  return { fixture, catalog: catalogBinding, full: catalog };
}

/** Deeply mutable mirror of RawPreviewBook for adversarial mutation. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const clone = (raw: RawPreviewBook): Mutable<RawPreviewBook> =>
  JSON.parse(JSON.stringify(raw)) as Mutable<RawPreviewBook>;

describe('isSafePreviewFilename', () => {
  it('accepts only bare keccak-style basenames with image extensions', () => {
    expect(isSafePreviewFilename('ia-00-invisible-assist.png')).toBe(true);
    expect(isSafePreviewFilename('ia-00-motion.mp4')).toBe(true);
    expect(isSafePreviewFilename('../outside.png')).toBe(false);
    expect(isSafePreviewFilename('sub/dir/ia-00.png')).toBe(false);
    expect(isSafePreviewFilename('ia-00.exe')).toBe(false);
    expect(isSafePreviewFilename('ia-00.png?x=1')).toBe(false);
    expect(isSafePreviewFilename('.hidden.png')).toBe(false);
    expect(isSafePreviewFilename('')).toBe(false);
    expect(isSafePreviewFilename(42 as unknown as string)).toBe(false);
  });
});

describe('bindPreviewBook (authoritative binding)', () => {
  it('binds the committed golden manifest completely: 13 previews + featured motion', async () => {
    const { fixture, catalog, full } = await bindings();
    const raw = loadPreviewBook();
    expect(raw.records.length).toBeGreaterThanOrEqual(13);
    const book = bindPreviewBook(raw, fixture, catalog);
    for (const entry of [full.featured, ...full.chapters]) {
      expect(book.byId.has(entry.catalogId), entry.catalogId).toBe(true);
    }
    expect(book.motion).not.toBeNull();
    expect(book.motion?.fromMs).toBe(full.featured.focusMs);
  });

  it('drops a preview whose focusMs contradicts the chapter timestamp', async () => {
    const { fixture, catalog } = await bindings();
    const raw = clone(loadPreviewBook());
    const target = raw.records.find((r) => r.catalogId === 'ia-03-measured-checkpoint');
    if (target === undefined) throw new Error('record missing');
    target.focusMs += 100; // one frame off = the wrong football instant
    const book = bindPreviewBook(raw, fixture, catalog);
    expect(book.byId.has('ia-03-measured-checkpoint')).toBe(false);
    expect(book.byId.has('ia-01-possession-settles')).toBe(true); // others intact
  });

  it('drops a preview whose camera contradicts the chapter framing', async () => {
    const { fixture, catalog } = await bindings();
    const raw = clone(loadPreviewBook());
    const target = raw.records.find((r) => r.catalogId === 'ia-10-the-equalizer');
    if (target === undefined) throw new Error('record missing');
    target.camera = 'overhead'; // manifest claims a different camera than the catalog
    const book = bindPreviewBook(raw, fixture, catalog);
    expect(book.byId.has('ia-10-the-equalizer')).toBe(false);
  });

  it('drops previews unknown to the catalog and duplicates entirely (ambiguous provenance)', async () => {
    const { fixture, catalog } = await bindings();
    const raw = clone(loadPreviewBook());
    const target = raw.records.find((r) => r.catalogId === 'ia-04-top-speed');
    if (target === undefined) throw new Error('record missing');
    raw.records.push({ ...target }); // duplicate id
    raw.records.push({ ...target, catalogId: 'not-a-chapter', src: '/moment-previews/x.png' });
    const book = bindPreviewBook(raw, fixture, catalog);
    expect(book.byId.has('ia-04-top-speed')).toBe(false); // duplicate → both dropped
    expect(book.byId.has('not-a-chapter')).toBe(false); // not in the catalog
    expect(book.byId.has('ia-05-lane-opens')).toBe(true);
  });

  it('withholds the entire book on a stale fixture fingerprint', async () => {
    const { fixture, catalog } = await bindings();
    const base = clone(loadPreviewBook());
    for (const mutate of [
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint!.eventsSha256 = 'sha256:' + '0'.repeat(64);
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint!.trackingSha256 = 'sha256:' + '0'.repeat(64);
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint!.seed = 99999;
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint!.generatorVersion = 'fixture-engine-v0';
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint!.matchId = 'some-other-match';
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.fingerprint = null;
      },
    ]) {
      const raw = clone(base);
      mutate(raw);
      expect(bindPreviewBook(raw, fixture, catalog)).toEqual(EMPTY_PREVIEW_BOOK);
    }
  });

  it('withholds the featured motion when its interval, camera or poster contradicts the catalog', async () => {
    const { fixture, catalog, full } = await bindings();
    const base = clone(loadPreviewBook());
    for (const mutate of [
      (raw: Mutable<RawPreviewBook>): void => {
        raw.motion!.fromMs += 100;
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.motion!.toMs = catalog.windowMs[1] + 1;
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.motion!.camera = 'broadcast';
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.motion!.catalogId = 'ia-05-lane-opens';
      },
      (raw: Mutable<RawPreviewBook>): void => {
        raw.motion!.poster = '/moment-previews/something-else.png';
      },
    ]) {
      const raw = clone(base);
      mutate(raw);
      const book = bindPreviewBook(raw, fixture, catalog);
      expect(book.motion, JSON.stringify(mutate)).toBeNull();
      expect(book.byId.get(full.featured.catalogId)).toBeDefined(); // still image survives
    }
  });
});

describe('loadPreviewBook (raw loader hardening)', () => {
  const tempDirs: string[] = [];
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
  });

  function writeManifestDirectory(manifest: unknown, files: string[]): RawPreviewBook {
    const root = mkdtempSync(path.join(tmpdir(), 'kyneloom-previews-'));
    tempDirs.push(root);
    const dir = path.join(root, 'public', 'moment-previews');
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), 'stub');
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    // The loader resolves `<cwd>/public/moment-previews` first; point it at
    // the temp root for this test.
    process.chdir(root);
    return loadPreviewBook();
  }

  afterEach(() => {
    if (previousCwd !== '') process.chdir(previousCwd);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('never accepts traversal or non-image filenames, even when the pointed-to file exists', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'kyneloom-outside-'));
    tempDirs.push(outside);
    writeFileSync(path.join(outside, 'outside.png'), 'secret');
    const manifest = {
      schemaVersion: '1.0',
      matchId: 'synthetic-derby-01',
      fixture: { seed: 24017, generatorVersion: 'fixture-engine-v1' },
      previews: [
        {
          catalogId: 'a',
          file: '../outside.png',
          focusMs: 1,
          camera: 'overhead',
          width: 10,
          height: 10,
        },
        {
          catalogId: 'b',
          file: 'nested/file.png',
          focusMs: 1,
          camera: 'overhead',
          width: 10,
          height: 10,
        },
        { catalogId: 'c', file: 'evil.exe', focusMs: 1, camera: 'overhead', width: 10, height: 10 },
        { catalogId: 'd', file: 'ok.png', focusMs: 1, camera: 'overhead', width: 10, height: 10 },
      ],
    };
    const raw = writeManifestDirectory(manifest, ['nested/file.png', 'evil.exe', 'ok.png']);
    expect(raw.records.map((r) => r.catalogId)).toEqual(['d']);
    expect(existsSync(path.join(outside, 'outside.png'))).toBe(true); // the file existed; it was never read
  });

  it('returns an empty raw book for unreadable or malformed manifests', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kyneloom-previews-'));
    tempDirs.push(root);
    const dir = path.join(root, 'public', 'moment-previews');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), '{not json');
    process.chdir(root);
    expect(loadPreviewBook().records).toEqual([]);
  });

  it('reads the committed golden manifest with a fingerprint matching the current fixture', async () => {
    const { fixture } = await bindings();
    const raw = loadPreviewBook();
    expect(raw.fingerprint).not.toBeNull();
    expect(raw.fingerprint?.matchId).toBe(fixture.matchId);
    expect(raw.fingerprint?.seed).toBe(fixture.seed);
    expect(raw.fingerprint?.generatorVersion).toBe(fixture.generatorVersion);
    expect(raw.fingerprint?.eventsSha256).toBe(fixture.eventsSha256);
    expect(raw.fingerprint?.trackingSha256).toBe(fixture.trackingSha256);
    // The manifest's fixture hashes equal the committed metadata's own
    // integrity block — verified against the source of truth, not itself.
    const metadata = JSON.parse(
      readFileSync('tests/fixtures/generated/synthetic-derby-01/metadata.json', 'utf-8'),
    ) as { integrity?: { events?: string; tracking?: string } };
    expect(raw.fingerprint?.eventsSha256).toBe(metadata.integrity?.events ?? null);
    expect(raw.fingerprint?.trackingSha256).toBe(metadata.integrity?.tracking ?? null);
  });
});
