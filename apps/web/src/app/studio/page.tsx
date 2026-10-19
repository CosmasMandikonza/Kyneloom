import type { Metadata } from 'next';
import Link from 'next/link';
import { formatMatchClock, loadGoldenMatch } from '@/lib/match-fixture';
import './studio.css';

export const metadata: Metadata = {
  title: 'Studio — production workspace',
  description:
    'Kyneloom Studio workspace shell: preview-dominant layout with timeline, inspector and publication areas. Editing workflows are not implemented yet; unavailable controls are visibly disabled.',
};

const DISABLED_TOOLS = [
  { label: 'Camera track editor', reason: 'Requires compiled MomentManifest drafts (Issue #16).' },
  {
    label: 'Overlay composer',
    reason: 'Requires the manifest overlay grammar wired to evidence (Issue #16).',
  },
  {
    label: 'Claim review',
    reason: 'Requires Foundry agent proposals with typed traces (Issue #15).',
  },
] as const;

/**
 * Studio — the production workspace. Preview-dominant: the large region is
 * the moment preview (same stage contract as Explore); below it a multi-track
 * timeline scaffold, a contextual inspector and a publication lane. Every
 * unimplemented workflow is visibly disabled with its real dependency —
 * no invented activity.
 */
export default async function StudioPage() {
  const golden = await loadGoldenMatch();

  return (
    <main id="main-content" className="studio">
      <div className="studio__bar">
        <div className="container studio__bar-inner">
          <nav className="studio__breadcrumb mono" aria-label="Breadcrumb">
            <Link href="/explore">Explore</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Studio</span>
          </nav>
          <p className="studio__bar-title">The Invisible Assist — draft</p>
          <div className="studio__bar-actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled
              title="Saving requires draft revisions (Issue #17)"
            >
              Save draft
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled
              title="Publication requires the release workflow (Issues #17–#18)"
            >
              Publish
            </button>
          </div>
        </div>
      </div>

      <div className="studio__grid container">
        {/* Honest authorization boundary (KYN-11 review): no authentication,
            tenant isolation or producer authority exists yet — this route is
            a public read-only scaffold until Issue #21 ships the real
            server-enforced auth/tenant policy. Nothing here is gated by (or
            grants privileges through) a viewing lens. */}
        <p className="studio__auth-note" role="note">
          <span className="chip chip--not-implemented">Authentication · Issue #21</span>
          Professional sign-in, tenant isolation and publisher authority are not implemented — this
          public scaffold cannot edit, approve or publish anything, and switching viewer lenses
          never changes that.
        </p>

        {/* Preview — dominant */}
        <section className="studio__preview" aria-labelledby="preview-title">
          <div className="visually-hidden" id="preview-title">
            Moment preview
          </div>
          <div className="scene-stage studio__stage" data-scene-mount="">
            <div className="studio__stage-lines" aria-hidden="true" />
            <div className="studio__placeholder">
              <p className="chip chip--not-implemented">Not implemented</p>
              <p className="studio__placeholder-body">
                The moment preview renders the same R3F scene as Explore (Issue #6). Producer-safe
                areas and shot framing guides land with the Studio preview integration (Issue #17).
              </p>
            </div>
            <p className="studio__preview-hud mono" aria-hidden="true">
              PREVIEW · SAFE AREAS OFF
            </p>
          </div>
        </section>

        {/* Inspector */}
        <aside className="studio__inspector" aria-labelledby="inspector-title">
          <h2 id="inspector-title" className="studio__panel-title">
            Inspector
          </h2>
          {golden.ok ? (
            <>
              <dl className="studio__inspector-grid">
                <div>
                  <dt>Manifest</dt>
                  <dd className="mono">mom-synthetic-78m</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd className="mono">no draft exists</dd>
                </div>
                <div>
                  <dt>Window</dt>
                  <dd className="mono">
                    {formatMatchClock(golden.data.goldenWindowMs[0])}–
                    {formatMatchClock(golden.data.goldenWindowMs[1])}
                  </dd>
                </div>
                <div>
                  <dt>Events</dt>
                  <dd className="mono">{golden.data.eventCount}</dd>
                </div>
              </dl>
              <div className="studio__inspector-note">
                <p className="chip chip--evidence">Evidence-ready</p>
                <p>
                  The measured separation evidence (≈ +14 m, source frames frame-47205 →
                  frame-47240) exists in the fixture and will be reviewable here once claim review
                  is wired.
                </p>
              </div>
            </>
          ) : (
            <p role="note">{golden.message}</p>
          )}
        </aside>

        {/* Timeline scaffold */}
        <section className="studio__timeline" aria-labelledby="timeline-title">
          <div className="studio__timeline-head">
            <h2 id="timeline-title" className="studio__panel-title">
              Timeline
            </h2>
            <span className="mono studio__timeline-span">
              {golden.ok
                ? `${formatMatchClock(golden.data.goldenWindowMs[0])} – ${formatMatchClock(golden.data.goldenWindowMs[1])}`
                : '—'}
            </span>
          </div>
          <div
            className="studio__tracks"
            role="img"
            aria-label="Timeline scaffold: camera shots track, events track and overlay timing track, all empty pending manifest drafts"
          >
            <div className="studio__track">
              <span className="studio__track-label mono">CAMERA</span>
              <div className="studio__track-lane" />
            </div>
            <div className="studio__track">
              <span className="studio__track-label mono">EVENTS</span>
              <div className="studio__track-lane studio__track-lane--events">
                {golden.ok
                  ? golden.data.projected.acceptedEvents
                      .filter(
                        (event) =>
                          event.occurredAtMs >= golden.data.goldenWindowMs[0] &&
                          event.occurredAtMs <= golden.data.goldenWindowMs[1],
                      )
                      .map((event: { eventId: string; occurredAtMs: number; kind: string }) => (
                        <span
                          key={event.eventId}
                          className="studio__event"
                          style={{
                            left: `${
                              ((event.occurredAtMs - golden.data.goldenWindowMs[0]) /
                                (golden.data.goldenWindowMs[1] - golden.data.goldenWindowMs[0])) *
                              100
                            }%`,
                          }}
                          title={`${event.kind} @ ${event.occurredAtMs} ms`}
                        />
                      ))
                  : null}
              </div>
            </div>
            <div className="studio__track">
              <span className="studio__track-label mono">OVERLAYS</span>
              <div className="studio__track-lane" />
            </div>
          </div>
          <p className="studio__timeline-note">
            Track editing is disabled until typed manifest drafts exist (Issues #16–#17).
          </p>
        </section>

        {/* Tools + publication lane */}
        <section className="studio__tools" aria-labelledby="tools-title">
          <h2 id="tools-title" className="studio__panel-title">
            Tools
          </h2>
          <ul className="studio__tools-list">
            {DISABLED_TOOLS.map((tool) => (
              <li key={tool.label}>
                <button type="button" className="studio__tool" disabled title={tool.reason}>
                  {tool.label}
                </button>
                <p className="studio__tool-reason">{tool.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
