import type { Metadata } from 'next';
import Link from 'next/link';
import { formatMatchClock, loadGoldenMatch } from '@/lib/match-fixture';
import { ReplayStage } from './replay-stage';
import './explore.css';

export const metadata: Metadata = {
  title: 'Explore — The Invisible Assist',
  description:
    'The Living Replay stage: a canvas-ready, full-bleed scene shell for the synthetic 78th-minute moment. The 3D renderer itself is not implemented yet.',
};

/**
 * Explore — the Living Replay stage. Full-bleed scene region with floating
 * match context, camera/lens architecture and a playback rail. Every shown
 * fact comes from the committed golden fixture through the authoritative
 * reducer; the 3D scene itself is explicitly Not implemented (KYN-06).
 */
export default async function ExplorePage() {
  const golden = await loadGoldenMatch();

  return (
    <main id="main-content" className="explore">
      <ReplayStage
        windowStartLabel={golden.ok ? formatMatchClock(golden.data.goldenWindowMs[0]) : '—'}
        windowEndLabel={golden.ok ? formatMatchClock(golden.data.goldenWindowMs[1]) : '—'}
        checkpointLabel={golden.ok ? formatMatchClock(golden.data.checkpointMs) : '—'}
        windowSpanMs={
          golden.ok ? golden.data.goldenWindowMs[1] - golden.data.goldenWindowMs[0] : null
        }
      />

      {golden.ok ? (
        <section className="explore__meta panel" aria-labelledby="meta-title">
          <h2 id="meta-title" className="visually-hidden">
            Moment metadata
          </h2>
          <p className="explore__meta-narrative">{golden.data.narrative}</p>
          <dl className="explore__meta-grid">
            <div>
              <dt>Match</dt>
              <dd className="mono">{golden.data.matchId}</dd>
            </div>
            <div>
              <dt>Score at checkpoint</dt>
              <dd className="mono">
                {golden.data.stateAtCheckpoint.score.home}–
                {golden.data.stateAtCheckpoint.score.away}
              </dd>
            </div>
            <div>
              <dt>Period</dt>
              <dd className="mono">{golden.data.stateAtCheckpoint.period.replace('_', ' ')}</dd>
            </div>
            <div>
              <dt>Players on pitch</dt>
              <dd className="mono">{golden.data.stateAtCheckpoint.players.length}</dd>
            </div>
            <div>
              <dt>Ball possessor</dt>
              <dd className="mono">
                {golden.data.stateAtCheckpoint.ball.possessorEntityId ?? 'not source-identified'}
              </dd>
            </div>
            <div>
              <dt>Provenance</dt>
              <dd className="mono">synthetic · seed {golden.data.seed}</dd>
            </div>
          </dl>
          <p className="explore__meta-note">
            Positions and facts flow through the authoritative reducer (
            <span className="mono">matchStateAt</span>, revision{' '}
            {golden.data.stateAtCheckpoint.reducerRevision}). The 3D renderer (Issue #6) mounts into
            the stage above without redesigning this shell.
          </p>
          <div className="explore__meta-actions">
            <Link href="/studio" className="btn btn--ghost">
              Open in Studio
            </Link>
          </div>
        </section>
      ) : (
        <section className="explore__meta panel" role="note">
          <p className="chip chip--not-implemented">Fixture unavailable</p>
          <p>{golden.message}</p>
        </section>
      )}
    </main>
  );
}
