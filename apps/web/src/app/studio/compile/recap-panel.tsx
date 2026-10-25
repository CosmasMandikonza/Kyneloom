'use client';

import type { CompiledMomentView } from '@/lib/compiled-moment';
import { formatMatchClock } from '@/lib/clock';

/**
 * KYN-16 — the verified recap + immutable identity card, bound to the ACTIVE
 * artifact (review blocker C): recompiling swaps the recap in place with the
 * same hash the stage chip and the verdict show.
 */
export function RecapPanel({ active }: { readonly active: CompiledMomentView }) {
  const manifest = active.manifest;
  return (
    <section className="panel compile__recap" aria-labelledby="recap-title">
      <h2 id="recap-title" className="compile__section-title">
        Verified recap &amp; manifest identity
      </h2>
      <p className="compile__identity-title compile__recap-headline-label">
        Editorial headline — number-free, not fact-verified
      </p>
      <p className="compile__recap-headline">{active.recapHeadline}</p>
      <ul className="compile__claims" role="list">
        {active.recapLines.map((line) => (
          <li key={line.claimId} className="compile__claim" data-claim={line.claimId}>
            <span
              className={
                line.status === 'hypothesis' ? 'chip chip--not-implemented' : 'chip chip--evidence'
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
            <dd className="mono">{active.manifestId}</dd>
          </div>
          <div>
            <dt>manifestHash (sha256, canonical content incl. presentation)</dt>
            <dd className="mono compile__hash" data-identity-hash={active.manifestHash}>
              {active.manifestHash}
            </dd>
          </div>
          <div>
            <dt>input fingerprint</dt>
            <dd className="mono compile__hash">{active.inputFingerprint.slice(0, 59)}…</dd>
          </div>
          <div>
            <dt>revision / status</dt>
            <dd className="mono">
              {String(active.revision)} · {active.status} · approval{' '}
              {active.approvalNull ? 'null' : '?!'}
            </dd>
          </div>
          <div>
            <dt>moment window</dt>
            <dd className="mono">
              {formatMatchClock(active.momentWindowMs[0])}–
              {formatMatchClock(active.momentWindowMs[1])}
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
          exact hash — it already covers every audience-facing word (claims, cues, recap). The
          compiler can never mint an approval; that stays a server publication workflow (docs/06,
          docs/10).
        </p>
      </div>
    </section>
  );
}
