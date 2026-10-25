import type { Metadata } from 'next';
import Link from 'next/link';
import { cameraTrackToThree } from '@kyneloom/scene-renderer';
import { rescaleCameraTrackToWindow } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildEvidenceProjection, type EvidenceProjection } from '@/lib/evidence-data';
import { buildSceneData } from '@/lib/scene-data';
import { buildCompilerSource, buildWorkbenchPayload } from '@/lib/moment-compiler-service';
import { formatMatchClock } from '@/lib/clock';
import { CompiledStage } from './compiled-stage';
import { CompilerWorkbench } from './compiler-workbench';
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
 * only typed results. The stage is the existing Living Replay — not a second
 * player — with the compiled manifest's directed camera, overlay cues and
 * identity bound to it.
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
  const manifest = result.manifest;
  const momentStartMs = manifest.timeRangeMs[0];
  const momentDurationMs = manifest.timeRangeMs[1] - manifest.timeRangeMs[0];

  // The compiled moment plays inside the golden-window scene; its directed
  // camera offsets are re-expressed on the scene window exactly once, through
  // the shared rescale helper (never ad-hoc arithmetic in a component).
  const baseScene = buildSceneData(golden, { initialFocusMs: momentStartMs });
  const directed = manifest.scene.cameraTracks.find((track) => track.mode === 'directed');
  const scene =
    baseScene === null
      ? null
      : {
          ...baseScene,
          directedTrack:
            directed !== undefined
              ? rescaleCameraTrackToWindow(
                  cameraTrackToThree(directed),
                  momentStartMs,
                  baseScene.windowMs[0],
                )
              : baseScene.directedTrack,
        };
  const evidence: EvidenceProjection = buildEvidenceProjection(golden);
  const candidate = payload.source.candidate;

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

        {scene !== null ? (
          <CompiledStage
            scene={scene}
            evidence={evidence}
            compiled={{
              manifestId: manifest.manifestId,
              manifestHash: result.manifestHash,
              momentWindowMs: [manifest.timeRangeMs[0], manifest.timeRangeMs[1]],
              cues: result.presentation.broadcast,
            }}
            momentStartMs={momentStartMs}
            momentDurationMs={momentDurationMs}
          />
        ) : (
          <section className="panel compile__unavailable" role="note">
            <p className="chip chip--not-implemented">Scene unavailable</p>
            <p>The compiled manifest is valid, but the scene payload could not be built for it.</p>
          </section>
        )}

        <div className="compile__grid">
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
                  {formatMatchClock(evidence.evidence.toMs)} · {evidence.evidence.algorithmVersion}{' '}
                  · re-verified server-side against accepted tracking. The compiled moment cites
                  this same metric family at its own detected window.
                </p>
              </div>
            ) : (
              <p className="compile__evidence-note">
                The canonical X-Ray measurement is currently withheld ({evidence.reason}). The
                compiler only ever cites metrics it can re-verify.
              </p>
            )}
          </section>

          <CompilerWorkbench entries={payload.entries} initialResult={payload.initialResult} />
        </div>

        <section className="panel compile__recap" aria-labelledby="recap-title">
          <h2 id="recap-title" className="compile__section-title">
            Verified recap &amp; manifest identity
          </h2>
          <p className="compile__recap-headline">{result.presentation.recap.headline}</p>
          <ul className="compile__claims" role="list">
            {result.presentation.recap.lines.map((line) => (
              <li key={line.claimId} className="compile__claim" data-claim={line.claimId}>
                <span
                  className={
                    line.status === 'hypothesis'
                      ? 'chip chip--not-implemented'
                      : 'chip chip--evidence'
                  }
                >
                  {line.status}
                </span>
                <span className="compile__claim-text">{line.text}</span>
                {line.inferenceDisclosure !== undefined ? (
                  <span className="compile__claim-disclosure">{line.inferenceDisclosure}</span>
                ) : null}
                <span className="mono compile__claim-evidence">
                  evidence: {line.evidenceIds.join(', ')}
                </span>
              </li>
            ))}
          </ul>
          <div className="compile__identity">
            <p className="compile__identity-title">Immutable manifest identity</p>
            <dl className="compile__facts">
              <div>
                <dt>manifestId</dt>
                <dd className="mono">{manifest.manifestId}</dd>
              </div>
              <div>
                <dt>manifestHash (sha256, canonical content)</dt>
                <dd className="mono compile__hash" data-identity-hash={result.manifestHash}>
                  {result.manifestHash}
                </dd>
              </div>
              <div>
                <dt>input fingerprint</dt>
                <dd className="mono compile__hash">{result.inputFingerprint.slice(0, 59)}…</dd>
              </div>
              <div>
                <dt>revision / status</dt>
                <dd className="mono">
                  {String(manifest.revision)} · {manifest.status} · approval null
                </dd>
              </div>
              <div>
                <dt>input</dt>
                <dd className="mono">
                  reducer rev {String(manifest.input.reducerRevision)} ·{' '}
                  {String(manifest.input.sourceEventIds.length)} events ·{' '}
                  {String(manifest.input.trackingSampleRefs.length)} frames
                </dd>
              </div>
              <div>
                <dt>rights</dt>
                <dd className="mono">{manifest.rightsPolicyRef}</dd>
              </div>
            </dl>
            <p className="compile__identity-note">
              Later Studio and publishing work (Issues #17–#18) bind approvals and releases to this
              exact hash. The compiler can never mint an approval — that stays a server publication
              workflow (docs/06, docs/10).
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
