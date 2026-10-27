import type { Metadata } from 'next';
import Link from 'next/link';
import { buildCompileCorpus } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection, type EvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { buildCompilerSource, buildWorkbenchPayload } from '@/lib/moment-compiler-service';
import { formatMatchClock } from '@/lib/clock';
import { StudioExperience } from './editor/studio-experience';
// The moment plays in the Explore stage component; its stage, transport, chip
// and overlay styling lives in explore.css (shared law, one implementation).
import '@/app/explore/explore.css';
import './studio.css';

export const metadata: Metadata = {
  title: 'Studio — production workspace',
  description:
    'Kyneloom Studio: direct the moment — edit camera shots, overlays and editorial captions on a typed draft, watch the real 3D replay respond, save local revisions and recompile through the deterministic compiler.',
};

/**
 * /studio — the production editing workspace (KYN-17).
 *
 * The server assembles the TRUSTED world exactly like /studio/compile: the
 * committed golden fixture, the authoritative compiler source, the
 * deterministic golden proposal and its compiled manifest. The client owner
 * (StudioExperience) turns that baseline into an editable, undoable,
 * locally-persisted draft whose every edit recompiles through the same
 * deterministic compiler. No authenticated server persistence exists yet
 * (KYN-21) — drafts save to THIS browser, labeled as such.
 */
export default async function StudioPage() {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);

  if (!source.ok) {
    return (
      <main id="main-content" className="studio-shell">
        <div className="container">
          <section className="panel studio-shell__unavailable" role="note">
            <p className="chip chip--not-implemented">Studio unavailable</p>
            <p>{source.message}</p>
            <p>
              <Link href="/explore">The Living Replay</Link> keeps running on the fixture itself.
            </p>
          </section>
        </div>
      </main>
    );
  }

  const workbench = buildWorkbenchPayload(golden, source);

  if (!workbench.ok || !workbench.payload.initialResult.ok) {
    return (
      <main id="main-content" className="studio-shell">
        <div className="container">
          <section className="panel studio-shell__unavailable" role="note">
            <p className="chip chip--not-implemented">Studio unavailable</p>
            <p>{workbench.ok ? 'The initial compilation failed.' : workbench.message}</p>
            <p>
              <Link href="/explore">The Living Replay</Link> keeps running on the fixture itself,
              and <Link href="/studio/compile">the moment compiler</Link> surfaces the exact
              failure.
            </p>
          </section>
        </div>
      </main>
    );
  }

  const corpus = buildCompileCorpus(source.snapshot.context);
  const initialResult = workbench.payload.initialResult;
  const candidate = workbench.payload.source.candidate;
  const baseScene = buildSceneData(golden, { initialFocusMs: corpus.golden.timeRangeMs[0] });
  if (baseScene === null) {
    return (
      <main id="main-content" className="studio-shell">
        <div className="container">
          <section className="panel studio-shell__unavailable" role="note">
            <p className="chip chip--not-implemented">Scene unavailable</p>
            <p>The compiled manifest is valid, but the scene payload could not be built for it.</p>
          </section>
        </div>
      </main>
    );
  }
  const evidence: EvidenceProjection = buildEvidenceProjection(golden);

  return (
    <main id="main-content" className="studio-shell">
      <StudioExperience
        baseScene={baseScene}
        evidence={evidence}
        initialProposal={corpus.golden}
        initialResult={initialResult}
        sourcePanel={
          <section className="panel studio-source" aria-labelledby="studio-source-title">
            <h2 id="studio-source-title" className="studio-source__title">
              Source moment
            </h2>
            <dl className="studio-source__facts">
              <div>
                <dt>candidate</dt>
                <dd className="mono">{candidate.candidateId}</dd>
              </div>
              <div>
                <dt>detected window</dt>
                <dd className="mono">
                  {formatMatchClock(candidate.windowMs[0])}–
                  {formatMatchClock(candidate.windowMs[1])}
                </dd>
              </div>
              <div>
                <dt>reducer revision</dt>
                <dd className="mono">{String(workbench.payload.source.reducerRevision)}</dd>
              </div>
              <div>
                <dt>source content</dt>
                <dd
                  className="mono studio-source__hash"
                  title={workbench.payload.source.sourceHash}
                >
                  {workbench.payload.source.sourceHash.slice(7, 31)}…
                </dd>
              </div>
            </dl>
            <p className="studio-source__note">
              Drafts bind to this exact source revision; a source correction makes them stale and
              the compiler says so. Local demonstration editing mode — no authentication (KYN-21),
              no approval or release authority exists in this browser.
            </p>
          </section>
        }
      />
    </main>
  );
}
