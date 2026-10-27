'use client';

import type { CompileResult } from '@kyneloom/moment-compiler';
import type { CorpusEntryCard } from '@/lib/moment-compiler-service';

/**
 * KYN-16 — the compiler workbench (controlled). The owner
 * (CompileExperience) holds compilation state; this panel renders the
 * selection, triggers the real API compile, and shows the LATEST verdict —
 * exact field-path errors, or the hashed manifest — plus which artifact the
 * stage is actually playing. Nothing is fabricated client-side.
 */
export function CompilerWorkbench({
  entries,
  selectedId,
  onSelect,
  onCompile,
  busy,
  verdict,
  verdictEntryId,
  requestError,
  activeHash,
}: {
  readonly entries: readonly CorpusEntryCard[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onCompile: () => void;
  readonly busy: boolean;
  readonly verdict: CompileResult;
  readonly verdictEntryId: string;
  readonly requestError: string | null;
  readonly activeHash: string;
}) {
  return (
    <section className="compile__workbench panel" aria-labelledby="workbench-title">
      <h2 id="workbench-title" className="compile__section-title">
        Compile a proposal
      </h2>
      <p className="compile__section-note">
        Proposals are untrusted documents. The deterministic compiler validates them against the
        committed fixture — revision, evidence, rights, numbers, text — and either emits a
        content-hashed manifest (which the stage immediately plays) or rejects with exact field
        paths. Identical inputs always produce identical hashes.
      </p>

      <ul className="compile__entries" role="list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="compile__entry"
              aria-pressed={entry.id === selectedId}
              data-entry={entry.id}
              onClick={() => onSelect(entry.id)}
            >
              <span className="compile__entry-head">
                <span className="compile__entry-label">{entry.label}</span>
                <span
                  className={
                    entry.expect === 'valid' ? 'chip chip--synthetic' : 'chip chip--not-implemented'
                  }
                >
                  {entry.expect === 'valid' ? 'should compile' : 'should reject'}
                </span>
              </span>
              <span className="compile__entry-desc">{entry.description}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="compile__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onCompile}
          disabled={busy}
          data-testid="compile-proposal"
        >
          {busy ? 'Compiling…' : 'Compile proposal'}
        </button>
        <span className="compile__actions-note mono">
          POST /api/moment/compile · server-side · no cache
        </span>
      </div>

      {requestError !== null ? (
        <p className="compile__request-error" role="alert">
          {requestError}
        </p>
      ) : null}

      <div
        className="compile__verdict"
        data-verdict={verdict.ok ? 'valid' : 'invalid'}
        data-compiled-entry={verdictEntryId}
      >
        {verdict.ok ? (
          <div className="compile__verdict-ok">
            <p className="chip chip--synthetic">Compiled</p>
            <dl className="compile__facts">
              <div>
                <dt>manifestId</dt>
                <dd className="mono">{verdict.manifest.manifestId}</dd>
              </div>
              <div>
                <dt>manifestHash</dt>
                <dd className="mono compile__hash">{verdict.manifestHash}</dd>
              </div>
              <div>
                <dt>status</dt>
                <dd className="mono">
                  {verdict.manifest.status} · approval{' '}
                  {verdict.manifest.approval === null ? 'null' : '?!'}
                </dd>
              </div>
              <div>
                <dt>verified metrics</dt>
                <dd className="mono">
                  {verdict.metrics
                    .map((metric) => `${metric.kind} (${metric.algorithmVersion})`)
                    .join(', ')}
                </dd>
              </div>
              <div>
                <dt>semantic checks</dt>
                <dd className="mono">{verdict.checks.map((check) => check.id).join(' · ')}</dd>
              </div>
              <div>
                <dt>broadcast cues</dt>
                <dd className="mono">
                  {String(verdict.manifest.presentation?.broadcast.length ?? 0)}
                </dd>
              </div>
            </dl>
            <p className="compile__verdict-note">
              {verdict.manifestHash === activeHash
                ? 'This is the artifact the stage is playing.'
                : 'Compiled — the stage is still playing the previously accepted artifact.'}
            </p>
          </div>
        ) : (
          <div className="compile__verdict-bad">
            <p className="chip chip--not-implemented">
              Rejected · {String(verdict.errors.length)} error
              {verdict.errors.length === 1 ? '' : 's'}
            </p>
            <ul className="compile__errors" role="list">
              {verdict.errors.map((error, index) => (
                <li key={`${error.fieldPath}-${String(index)}`} className="compile__error">
                  <span className="mono compile__error-path">{error.fieldPath}</span>
                  <span className="chip compile__error-code mono">{error.code}</span>
                  <span className="compile__error-message">{error.message}</span>
                </li>
              ))}
            </ul>
            <p className="compile__verdict-note">
              Nothing from this proposal entered the scene — the stage keeps playing{' '}
              <span className="mono">{activeHash.slice(7, 23)}…</span>.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
