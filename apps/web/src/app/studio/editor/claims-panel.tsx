'use client';

import type { ContractValidationError, MomentProposal } from '@kyneloom/contracts';
import type { VerifiedMetric } from '@kyneloom/moment-compiler';
import type { CompiledMomentView } from '@/lib/compiled-moment';

/**
 * KYN-17 — claims, evidence and the immutable identity card. Every claim
 * shows its verification status and exact evidence ids; the separation
 * measurement is the REAL verified metric (the compiler's own output), never
 * a second computation; the hash is the compiled artifact's content identity.
 */
export interface ClaimsPanelProps {
  readonly proposal: MomentProposal;
  readonly compiled: CompiledMomentView;
  readonly metrics: readonly VerifiedMetric[];
  readonly compileErrors: readonly ContractValidationError[];
  readonly staleMessage: string | null;
  readonly conflict: { readonly theirRevision: number } | null;
}

const SEPARATION_VALUE_LABELS: Record<string, string> = {
  separationBeforeM: 'before',
  separationAfterM: 'after',
  deltaM: 'Δ',
};

export function ClaimsPanel({
  compiled,
  metrics,
  compileErrors,
  staleMessage,
  conflict,
}: ClaimsPanelProps) {
  return (
    <section className="studio-claims" aria-label="Claims and evidence" data-claims-panel="">
      <h2 className="studio-claims__title">Claims &amp; evidence</h2>

      {conflict !== null ? (
        <div className="studio-claims__conflict" role="alert" data-conflict-banner="">
          <p className="studio-claims__conflict-title mono">EDITING CONFLICT</p>
          <p>
            Another editor session saved revision {String(conflict.theirRevision)} of this draft
            first. Your save was refused — nothing was overwritten. Reload the saved draft from the
            restore banner (or keep editing yours and re-save after adopting the newer revision).
          </p>
        </div>
      ) : null}

      {staleMessage !== null ? (
        <div className="studio-claims__stale" role="alert" data-stale-banner="">
          <p className="studio-claims__conflict-title mono">STALE SOURCE REVISION</p>
          <p>{staleMessage}</p>
        </div>
      ) : null}

      {compileErrors.length > 0 ? (
        <div className="studio-claims__rejected" role="alert" data-compile-errors="">
          <p className="studio-claims__conflict-title mono">
            REJECTED BY THE COMPILER — FIELD PATHS
          </p>
          <ul>
            {compileErrors.map((error) => (
              <li key={`${error.fieldPath}-${error.code}`}>
                <span className="mono studio-ins__error-path">{error.fieldPath}</span>
                <span>{error.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="studio-claims__list">
        {compiled.recapLines.map((line) => (
          <li key={line.claimId} className="studio-claims__claim" data-claim={line.claimId}>
            <span
              className={
                line.status === 'hypothesis' ? 'chip chip--amber mono' : 'chip chip--evidence mono'
              }
            >
              {line.status}
            </span>
            <p className="studio-claims__claim-text">{line.text}</p>
            {line.inferenceDisclosure !== undefined ? (
              <p className="studio-claims__disclosure">{line.inferenceDisclosure}</p>
            ) : null}
            <p className="studio-claims__claim-evidence mono">
              evidence: {line.evidenceIds.join(', ')}
            </p>
          </li>
        ))}
      </ul>

      {metrics.map((metric) => (
        <div key={metric.metricId} className="studio-claims__metric" data-metric={metric.alias}>
          <p className="studio-claims__metric-title mono">
            MEASURED · {metric.kind} · {metric.algorithmVersion}
          </p>
          <p className="studio-claims__metric-values mono">
            {Object.entries(metric.value)
              .filter(([field]) => SEPARATION_VALUE_LABELS[field] !== undefined)
              .map(
                ([field, value]) =>
                  `${SEPARATION_VALUE_LABELS[field] ?? field} ${typeof value === 'number' ? value.toFixed(3) : String(value)} m`,
              )
              .join(' · ')}{' '}
            ({metric.units})
          </p>
          <p className="studio-claims__metric-meta mono">
            frames {metric.dependsOn.sourceFrameIds.join(', ')} · fingerprint{' '}
            {metric.inputFingerprint.slice(7, 19)}… · verified by the deterministic compiler
          </p>
        </div>
      ))}

      <div className="studio-claims__identity" data-identity-card="">
        <p className="studio-claims__identity-title mono">IMMUTABLE MANIFEST IDENTITY</p>
        <dl className="studio-ins__facts">
          <div>
            <dt>manifest</dt>
            <dd className="mono">{compiled.manifestId}</dd>
          </div>
          <div>
            <dt>content hash</dt>
            <dd className="mono studio-claims__hash" data-compiled-hash={compiled.manifestHash}>
              {compiled.manifestHash}
            </dd>
          </div>
          <div>
            <dt>status</dt>
            <dd className="mono">
              {compiled.status} · approval {compiled.approvalNull ? 'null' : '?!'}
            </dd>
          </div>
          <div>
            <dt>input fingerprint</dt>
            <dd className="mono">{compiled.inputFingerprint.slice(0, 31)}…</dd>
          </div>
        </dl>
        <p className="studio-claims__identity-note">
          The hash covers every visible word (claims, cues, recap, camera). Recompiling an edit
          produces a NEW hash; approvals and releases bind to it in a future authorized server
          workflow (KYN-18) — never from this browser.
        </p>
      </div>
    </section>
  );
}
