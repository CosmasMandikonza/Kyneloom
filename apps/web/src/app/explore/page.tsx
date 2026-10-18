import type { Metadata } from 'next';
import Link from 'next/link';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import {
  buildMomentCatalogSafe,
  resolveMomentSelection,
  type MomentCatalogEntry,
} from '@/lib/moment-catalog';
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
 *
 * KYN-10 selection seam: `/explore?moment=<catalogId>` resolves the id
 * against the deterministic catalog SERVER-SIDE and, when valid, moves the
 * initial playhead to that chapter's validated source timestamp. Unknown or
 * malformed ids never reach the scene — the checkpoint stays authoritative
 * and an honest notice explains what happened. The default route and the
 * KYN-09 `?enter=orb` handoff are unchanged.
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const golden = await loadGoldenMatch();
  // ROUTE-BOUNDARY-SAFE (review round 2): a fixture that loads but fails
  // catalog validation must degrade ONLY the discovery selection — the
  // default replay below is built from the golden fixture directly and
  // keeps working. A catalog construction failure treats any moment
  // parameter as unknown (honest notice) instead of throwing a 500.
  const catalogStatus = buildMomentCatalogSafe(golden);
  const catalog = catalogStatus.ok ? catalogStatus.catalog : null;
  const params = await searchParams;
  const selection = resolveMomentSelection(catalog, params['moment']);
  const selectedEntry: MomentCatalogEntry | null =
    selection.status === 'selected' ? selection.entry : null;
  const scene = buildSceneData(golden, {
    initialFocusMs: selectedEntry?.focusMs,
  });
  const evidence = buildEvidenceProjection(golden);

  return (
    <main id="main-content" className="explore">
      {scene !== null ? (
        <ReplayStage
          scene={scene}
          evidence={evidence}
          chapterTitle={selectedEntry?.title ?? null}
        />
      ) : (
        <section className="explore__meta panel" role="note">
          <p className="chip chip--not-implemented">Fixture unavailable</p>
          <p>{golden.ok ? 'Scene data could not be built.' : golden.message}</p>
        </section>
      )}

      {selection.status === 'unknown' ? (
        <section className="explore__meta panel explore__selection-note" role="note">
          <p className="chip chip--not-implemented">Unknown moment</p>
          {golden.ok && !catalogStatus.ok ? (
            <p data-unknown-moment={selection.raw}>
              The moment catalog failed validation for this fixture, so the selection could not be
              resolved — the replay opened at the default checkpoint.{' '}
              <Link href="/moments">The gallery</Link> explains its truthful unavailable state.
            </p>
          ) : (
            <p data-unknown-moment={selection.raw}>
              No catalog chapter matches <span className="mono">{selection.raw}</span>, so the
              replay opened at the default checkpoint instead.{' '}
              <Link href="/moments">Browse the moment gallery</Link> for valid chapters.
            </p>
          )}
        </section>
      ) : null}

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
