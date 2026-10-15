import type { Metadata } from 'next';
import Link from 'next/link';
import './moment.css';

export const metadata: Metadata = {
  title: 'Published Moment',
  description:
    'The embeddable Published Moment viewer surface. No release has been published yet; this state is truthful.',
};

/**
 * Published Moment viewer (/m/[id]) — the responsive, embeddable presentation
 * surface. Layout, chrome-free frame and truthful states exist today; no
 * release has been published, so any id renders the honest unpublished state
 * (no fabricated releases, no fake embed content).
 */
export default async function MomentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main id="main-content" className="moment">
      <div className="moment__frame" data-embed-frame="">
        <div className="scene-stage moment__stage">
          <div className="moment__stage-lines" aria-hidden="true" />
          <div className="moment__placeholder">
            <p className="chip chip--not-implemented">Unpublished</p>
            <p className="moment__placeholder-title">No published moment exists</p>
            <p className="moment__placeholder-body">
              Moment <span className="mono">{id}</span> has no authorized release. Publication
              requires the manifest compiler and release workflow (Issues #16–#18); this viewer will
              render an approved, immutable release when one exists.
            </p>
          </div>
        </div>
        <div className="moment__bar">
          <span className="mono moment__id">{id}</span>
          <span className="mono moment__status">status: unpublished</span>
        </div>
      </div>
      <p className="moment__back">
        <Link href="/explore">← Back to Explore</Link>
      </p>
    </main>
  );
}
