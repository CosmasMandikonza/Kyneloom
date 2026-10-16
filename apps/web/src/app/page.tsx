import Link from 'next/link';
import { formatMatchClock, loadGoldenMatch } from '@/lib/match-fixture';
import { loadFixtureIndex } from '@/lib/fixtures';
import { fixtureDirectoryLabel } from '@/lib/fixture-status';
import './landing.css';

/**
 * Landing — "Enter the Moment". An editorial, cinematic entry: one statement,
 * one action, real fixture facts, and the pitch-toned depth the 3D scene will
 * occupy. No stock imagery, no invented statistics.
 */

const fixtureStatus = loadFixtureIndex();

export default async function LandingPage() {
  const golden = await loadGoldenMatch();
  const clock = golden.ok ? formatMatchClock(golden.data.goldenWindowMs[0]) : null;
  const finalScore = golden.ok
    ? `${golden.data.finalScore.home}–${golden.data.finalScore.away}`
    : null;

  return (
    <main id="main-content" className="landing">
      <section className="landing__stage" aria-labelledby="landing-title">
        {/* Abstract pitch geometry — pure CSS, the space the real R3F scene
            (KYN-06) will occupy. Not a mock of the replay. */}
        <div className="landing__pitchlines" aria-hidden="true" />
        <div className="landing__glow" aria-hidden="true" />
        <div className="landing__content">
          <p className="landing__eyebrow">
            <span className="mono">SYNTHETIC&nbsp;FIXTURE&nbsp;·</span> The Invisible Assist
          </p>
          <h1 id="landing-title" className="landing__title">
            Every moment
            <br />
            has a <em>world</em> inside.
          </h1>
          <p className="landing__lede">
            A 78th-minute goal you can enter, investigate and direct — built from a deterministic
            synthetic match, measured evidence and explorable space. The interactive replay itself
            arrives with the renderer milestone.
          </p>
          <div className="landing__actions">
            <Link href="/explore" className="btn btn--primary">
              Enter the moment
              <span aria-hidden="true">→</span>
            </Link>
            <Link href="/studio" className="btn btn--ghost">
              Open Studio
            </Link>
          </div>
          {golden.ok ? (
            <dl className="landing__facts" aria-label="Committed golden fixture facts">
              <div>
                <dt>Match clock</dt>
                <dd className="mono">{clock}</dd>
              </div>
              <div>
                <dt>Final score</dt>
                <dd className="mono">{finalScore}</dd>
              </div>
              <div>
                <dt>Tracking samples</dt>
                <dd className="mono">{golden.data.sampleCount.toLocaleString('en-US')}</dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd className="mono">{golden.data.seed}</dd>
              </div>
            </dl>
          ) : (
            <p className="landing__missing" role="note">
              {golden.message}
            </p>
          )}
        </div>
        <div className="landing__scrollhint" aria-hidden="true">
          <span className="mono">SCROLL</span>
          <span className="landing__scrollhint-line" />
        </div>
      </section>

      <section className="landing__chapters" aria-labelledby="chapters-title">
        <div className="container">
          <h2 id="chapters-title" className="landing__chapters-heading">
            One moment, four ways in
          </h2>
          <ol className="landing__chapters-list">
            <li>
              <span className="mono landing__chapters-index">01</span>
              <h3>Enter</h3>
              <p>
                Orbit the moment, scrub time, follow a player. The stage is prepared; the living 3D
                replay lands with the renderer.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">02</span>
              <h3>Understand</h3>
              <p>
                Evidence X-Ray ties every number to source frames — the measured 14&nbsp;m
                separation already exists in the data.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">03</span>
              <h3>Direct</h3>
              <p>
                Producers shape camera tracks and overlays from typed proposals in Studio, with
                approval before anything ships.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">04</span>
              <h3>Publish</h3>
              <p>
                A versioned, embeddable Playable Moment — no release exists yet, and the viewer says
                so honestly.
              </p>
            </li>
          </ol>
          <p className="landing__fixture-note">
            Fixture seam: <span className="mono">{fixtureDirectoryLabel(fixtureStatus)}</span> ·
            provenance synthetic-ground-truth, generator{' '}
            {golden.ok ? <span className="mono">{golden.data.generatorVersion}</span> : '—'}
          </p>
        </div>
      </section>
    </main>
  );
}
