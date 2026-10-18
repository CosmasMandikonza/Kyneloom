import type { Metadata } from 'next';
import Link from 'next/link';
import { loadGoldenMatch } from '@/lib/match-fixture';
import {
  buildMomentCatalogSafe,
  type MomentCatalog,
  type MomentCatalogEntry,
} from '@/lib/moment-catalog';
import { bindPreviewBook, EMPTY_PREVIEW_BOOK, loadPreviewBook } from './previews';
import { MomentGallery } from './moment-gallery';
import './moments.css';

export const metadata: Metadata = {
  title: 'Moments — Playable Moment gallery',
  description:
    'A cinematic gallery of Playable Moments: twelve source-grounded chapters of the verified synthetic sequence, each opening the real 3D Living Replay at its own timestamp.',
};

// Preview regeneration (`pnpm moments:previews`) must not require a rebuild:
// the preview book is read per request, exactly like Explore reads the
// fixture — so the gallery always tells the truth about what exists on disk.
export const dynamic = 'force-dynamic';

/** Entries the preview book must be bound to (featured + chapters). */
function catalogBinding(catalog: MomentCatalog): Parameters<typeof bindPreviewBook>[2] {
  const entries = new Map<string, { focusMs: number; camera: string }>();
  for (const entry of [catalog.featured, ...catalog.chapters] as const) {
    entries.set(entry.catalogId, { focusMs: entry.focusMs, camera: entry.previewCamera });
  }
  return { entries, featuredId: catalog.featured.catalogId, windowMs: catalog.windowMs };
}

/**
 * /moments (KYN-10) — discovery for the Playable Moment collection.
 *
 * The server builds the deterministic catalog from the accepted golden
 * fixture (never a second match engine) through the ROUTE-BOUNDARY-SAFE
 * wrapper: a fixture that loads but fails catalog validation (missing
 * chapter frames, no in-window goal, metadata/tracking contradiction)
 * renders the honest unavailable state below — never a server error.
 * Previews additionally BIND to the authoritative fixture + catalog before
 * display; stale or mismatched provenance degrades to the existing honest
 * preview-unavailable state with card navigation intact.
 */
export default async function MomentsPage() {
  const golden = await loadGoldenMatch();
  const catalogStatus = buildMomentCatalogSafe(golden);
  const catalog = catalogStatus.ok ? catalogStatus.catalog : null;

  const book =
    catalog !== null && golden.ok
      ? bindPreviewBook(
          loadPreviewBook(),
          {
            matchId: golden.data.matchId,
            seed: golden.data.seed,
            generatorVersion: golden.data.generatorVersion,
            eventsSha256: golden.data.integrity?.events ?? null,
            trackingSha256: golden.data.integrity?.tracking ?? null,
          },
          catalogBinding(catalog),
        )
      : EMPTY_PREVIEW_BOOK;

  if (catalog === null) {
    return (
      <main id="main-content" className="moments">
        <header className="container moments__header">
          <p className="mono moments__eyebrow">The gallery</p>
          <h1 className="moments__title">Playable Moments</h1>
        </header>
        <div className="container">
          <section className="panel moments__empty" role="note">
            <p className="chip chip--not-implemented">Catalog unavailable</p>
            <p>{catalogStatus.ok ? 'Unexpected state.' : catalogStatus.message}</p>
            <p>
              The gallery renders only chapters the accepted fixture actually contains — nothing is
              fabricated. <Link href="/explore">Explore</Link> keeps its own truthful state.
            </p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="moments">
      <header className="container moments__header">
        <p className="mono moments__eyebrow">The gallery · {catalog.matchId} · synthetic</p>
        <h1 className="moments__title">Playable Moments</h1>
        <p className="moments__lede">
          Football action presented as living artifacts. Pick a chapter and the real 3D world opens
          at that exact point in the match — scrub it, direct it, interrogate its evidence.
        </p>
      </header>
      <MomentGallery
        featured={catalog.featured}
        chapters={catalog.chapters}
        featuredPreview={book.byId.get(catalog.featured.catalogId) ?? null}
        chapterPreviews={catalog.chapters.map(
          (chapter: MomentCatalogEntry) => book.byId.get(chapter.catalogId) ?? null,
        )}
        motion={book.motion}
        matchId={catalog.matchId}
        seed={golden.ok ? golden.data.seed : null}
        generatorVersion={golden.ok ? golden.data.generatorVersion : null}
        windowMs={catalog.windowMs}
        story={catalog.story}
        previewMethod={book.method}
      />
    </main>
  );
}
