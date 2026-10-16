import type { Metadata } from 'next';
import Link from 'next/link';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildSceneData } from '@/lib/scene-data';
import { ReplayStage } from './replay-stage';
import './explore.css';

export const metadata: Metadata = {
  title: 'Explore — The Invisible Assist',
  description:
    'The Living Replay: 22 rigged footballers and the ball moving through the verified synthetic 78th-minute goal. Pause, scrub, switch cameras and follow the decoy run.',
};

/**
 * Explore — the Living Replay (KYN-06). The server loads the committed
 * golden fixture through the authoritative reducer and hands the client a
 * serializable scene projection (buildSceneData): 22 players, the ball, the
 * accepted tracking samples and the golden-window events. The renderer,
 * filesystem and reducer stay on the server side of this boundary.
 */
export default async function ExplorePage() {
  const golden = await loadGoldenMatch();
  const scene = buildSceneData(golden);

  return (
    <main id="main-content" className="explore">
      {scene !== null ? (
        <ReplayStage scene={scene} />
      ) : (
        <section className="explore__meta panel" role="note">
          <p className="chip chip--not-implemented">Fixture unavailable</p>
          <p>{golden.ok ? 'Scene data could not be built.' : golden.message}</p>
        </section>
      )}

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
            <span className="mono">sampleAt</span> semantics, revision{' '}
            {golden.data.stateAtCheckpoint.reducerRevision}). Limb animation is reconstructed
            presentation; world positions are measured tracking from seed {golden.data.seed}.
            Character base rig: Quaternius Universal Animation Library (CC0) — see the asset ledger
            in <span className="mono">docs/asset-ledger.md</span>.
          </p>
          <div className="explore__meta-actions">
            <Link href="/studio" className="btn btn--ghost">
              Open in Studio
            </Link>
          </div>
        </section>
      ) : null}
    </main>
  );
}
