import type { Metadata } from 'next';
import Link from 'next/link';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildMomentCatalog } from '@/lib/moment-catalog';
import { loadPreviewBook } from './previews';
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

/**
 * /moments (KYN-10) — discovery for the Playable Moment collection.
 *
 * The server builds the deterministic catalog from the accepted golden
 * fixture (never a second match engine), loads the preview provenance book
 * written by the offline capture pipeline, and hands the client a purely
 * serializable projection. Unavailable fixture → the honest empty state,
 * never fabricated chapters.
 */
export default async function MomentsPage() {
  const golden = await loadGoldenMatch();
  const catalog = buildMomentCatalog(golden);
  const book = loadPreviewBook();

  if (catalog === null) {
    const message = golden.ok
      ? 'The moment catalog could not be built from the fixture.'
      : golden.message;
    return (
      <main id="main-content" className="moments">
        <header className="container moments__header">
          <p className="mono moments__eyebrow">The gallery</p>
          <h1 className="moments__title">Playable Moments</h1>
        </header>
        <div className="container">
          <section className="panel moments__empty" role="note">
            <p className="chip chip--not-implemented">Catalog unavailable</p>
            <p>{message}</p>
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
          (chapter) => book.byId.get(chapter.catalogId) ?? null,
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
