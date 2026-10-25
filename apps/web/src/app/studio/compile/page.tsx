import type { Metadata } from 'next';
import Link from 'next/link';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection, type EvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { buildCompilerSource, buildWorkbenchPayload } from '@/lib/moment-compiler-service';
import { formatMatchClock } from '@/lib/clock';
import { CompileExperience } from './compile-experience';
// The compiled moment plays in the Explore stage component; its stage,
// transport, chip and overlay styling lives in explore.css (shared law, one
// implementation — never a copied second stylesheet).
import '@/app/explore/explore.css';
import './compile.css';

export const metadata: Metadata = {
  title: 'Moment Compiler — Studio',
  description:
    'Compile an untyped moment proposal into a validated, content-hashed Playable Moment and watch it in the Living Replay: directed camera, synchronized broadcast overlay, source-linked recap.',
};

/**
 * /studio/compile — the KYN-16 playable-moment compiler surface.
 *
 * Everything on this page is the real pipeline: the server loads the
 * committed golden fixture through the authoritative reducer, detects the
 * candidate moment deterministically (KYN-12), compiles the deterministic
 * local proposal corpus through the moment compiler, and hands the client
 * one owner (CompileExperience) that keeps the stage, overlay, recap and
 * identity bound to whatever artifact was last successfully compiled.
 */
export default async function CompilePage() {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  const workbench = buildWorkbenchPayload(golden, source);

  if (!workbench.ok) {
    return (
      <main id="main-content" className="compile">
        <div className="container">
          <section className="panel compile__unavailable" role="note">
            <p className="chip chip--not-implemented">Compiler unavailable</p>
            <p>{workbench.message}</p>
            <p>
              <Link href="/explore">The Living Replay</Link> keeps running on the fixture itself.
            </p>
          </section>
        </div>
      </main>
    );
  }

  const { payload } = workbench;
  const result = payload.initialResult;
  if (!result.ok) {
    // buildWorkbenchPayload already guarantees ok; kept for type narrowing.
    return null;
  }
  const candidate = payload.source.candidate;
  const momentStartMs = candidate.windowMs[0];

  // The scene BASE is the golden window's accepted tracking/players/events —
  // identical for every valid compile of this candidate. CompileExperience
  // binds each compiled manifest's directed camera to it client-side.
  const baseScene = buildSceneData(golden, { initialFocusMs: momentStartMs });
  if (baseScene === null) {
    return (
      <main id="main-content" className="compile">
        <div className="container">
          <section className="panel compile__unavailable" role="note">
            <p className="chip chip--not-implemented">Scene unavailable</p>
            <p>The compiled manifest is valid, but the scene payload could not be built for it.</p>
          </section>
        </div>
      </main>
    );
  }
  const evidence: EvidenceProjection = buildEvidenceProjection(golden);

  return (
    <main id="main-content" className="compile">
      <div className="container">
        <header className="compile__header">
          <nav className="studio__breadcrumb mono" aria-label="Breadcrumb">
            <Link href="/studio">Studio</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Moment compiler</span>
          </nav>
          <h1 className="compile__title">The Invisible Assist — compiled</h1>
          <div className="compile__chips">
            <span className="chip chip--synthetic">Synthetic · seed-truth fixture</span>
            <span className="chip chip--compiled mono">
              Local deterministic proposal · not Foundry
            </span>
            <span className="chip chip--evidence">
              {formatMatchClock(candidate.windowMs[0])}–{formatMatchClock(candidate.windowMs[1])}
            </span>
          </div>
        </header>

        <CompileExperience
          baseScene={baseScene}
          evidence={evidence}
          entries={payload.entries}
          initialResult={result}
          sourcePanel={
            <section className="panel compile__source" aria-labelledby="source-title">
              <h2 id="source-title" className="compile__section-title">
                Source moment &amp; evidence
              </h2>
              <dl className="compile__facts">
                <div>
                  <dt>candidate</dt>
                  <dd className="mono">{candidate.candidateId}</dd>
                </div>
                <div>
                  <dt>detected window</dt>
                  <dd className="mono">
                    {formatMatchClock(candidate.windowMs[0])}–
                    {formatMatchClock(candidate.windowMs[1])} ·{' '}
                    {((candidate.windowMs[1] - candidate.windowMs[0]) / 1000).toFixed(1)} s
                  </dd>
                </div>
                <div>
                  <dt>signals</dt>
                  <dd className="mono">{candidate.reasonCodes.join(' · ')}</dd>
                </div>
                <div>
                  <dt>anchor events</dt>
                  <dd className="mono">{candidate.anchorEventIds.join(', ')}</dd>
                </div>
                <div>
                  <dt>reducer revision</dt>
                  <dd className="mono">{String(payload.source.reducerRevision)}</dd>
                </div>
                <div>
                  <dt>source content</dt>
                  <dd className="mono compile__hash" title={payload.source.sourceHash}>
                    {payload.source.sourceHash}
                  </dd>
                </div>
              </dl>
              {evidence.status === 'verified' ? (
                <div className="compile__evidence">
                  <p className="compile__evidence-title">Canonical measurement (Evidence X-Ray)</p>
                  <p className="compile__evidence-numbers mono">
                    {evidence.evidence.separationBeforeM.toFixed(3)} m →{' '}
                    {evidence.evidence.separationAfterM.toFixed(3)} m · Δ{' '}
                    {evidence.evidence.deltaM.toFixed(3)} m
                  </p>
                  <p className="compile__evidence-note">
                    away-03 ↔ home-09 over {formatMatchClock(evidence.evidence.fromMs)}–
                    {formatMatchClock(evidence.evidence.toMs)} ·{' '}
                    {evidence.evidence.algorithmVersion} · re-verified server-side against accepted
                    tracking. The compiled moment cites this same metric family at its own detected
                    window.
                  </p>
                </div>
              ) : (
                <p className="compile__evidence-note">
                  The canonical X-Ray measurement is currently withheld ({evidence.reason}). The
                  compiler only ever cites metrics it can re-verify.
                </p>
              )}
            </section>
          }
        />
      </div>
    </main>
  );
}
