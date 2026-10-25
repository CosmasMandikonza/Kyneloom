'use client';

import { useCallback, useState } from 'react';
import type { CompileResult } from '@kyneloom/moment-compiler';
import type { CorpusEntryCard } from '@/lib/moment-compiler-service';

/**
 * KYN-16 — the compiler workbench: pick a proposal (the deterministic golden
 * corpus or one of its labeled red-team defects), compile it against the
 * trusted server source through the real API boundary
 * (`POST /api/moment/compile`), and read the verdict — a content-hashed
 * manifest or exact field-path errors. This is the same boundary a real
 * Foundry agent workflow will call; nothing here fakes compilation
 * client-side.
 */
export function CompilerWorkbench({
  entries,
  initialResult,
}: {
  readonly entries: readonly CorpusEntryCard[];
  readonly initialResult: CompileResult;
}) {
  const [selectedId, setSelectedId] = useState(entries[0]?.id ?? 'golden');
  const [result, setResult] = useState<CompileResult>(initialResult);
  const [compiledId, setCompiledId] = useState<string>(entries[0]?.id ?? 'golden');
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];

  const compile = useCallback(async (): Promise<void> => {
    if (selected === undefined || busy) return;
    setBusy(true);
    setRequestError(null);
    try {
      const response = await fetch('/api/moment/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selected.proposal),
      });
      if (!response.ok) {
        setRequestError(
          `The compile endpoint answered ${String(response.status)} — no result is shown.`,
        );
        return;
      }
      const payload = (await response.json()) as CompileResult;
      setResult(payload);
      setCompiledId(selected.id);
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? `Compilation request failed: ${error.message}`
          : 'Compilation request failed.',
      );
    } finally {
      setBusy(false);
    }
  }, [selected, busy]);

  return (
    <section className="compile__workbench panel" aria-labelledby="workbench-title">
      <h2 id="workbench-title" className="compile__section-title">
        Compile a proposal
      </h2>
      <p className="compile__section-note">
        Proposals are untrusted documents. The deterministic compiler validates them against the
        committed fixture — revision, evidence, rights, numbers — and either emits a content-hashed
        manifest or rejects with exact field paths. Identical inputs always produce identical
        hashes.
      </p>

      <ul className="compile__entries" role="list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="compile__entry"
              aria-pressed={entry.id === selectedId}
              data-entry={entry.id}
              onClick={() => setSelectedId(entry.id)}
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
          onClick={() => void compile()}
          disabled={busy || selected === undefined}
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
        data-verdict={result.ok ? 'valid' : 'invalid'}
        data-compiled-entry={compiledId}
      >
        {result.ok ? (
          <div className="compile__verdict-ok">
            <p className="chip chip--synthetic">Compiled</p>
            <dl className="compile__facts">
              <div>
                <dt>manifestId</dt>
                <dd className="mono">{result.manifest.manifestId}</dd>
              </div>
              <div>
                <dt>manifestHash</dt>
                <dd className="mono compile__hash">{result.manifestHash}</dd>
              </div>
              <div>
                <dt>status</dt>
                <dd className="mono">
                  {result.manifest.status} · approval{' '}
                  {result.manifest.approval === null ? 'null' : '?!'}
                </dd>
              </div>
              <div>
                <dt>verified metrics</dt>
                <dd className="mono">
                  {result.metrics
                    .map((metric) => `${metric.kind} (${metric.algorithmVersion})`)
                    .join(', ')}
                </dd>
              </div>
              <div>
                <dt>semantic checks</dt>
                <dd className="mono">{result.checks.map((check) => check.id).join(' · ')}</dd>
              </div>
              <div>
                <dt>broadcast cues</dt>
                <dd className="mono">{String(result.presentation.broadcast.length)}</dd>
              </div>
            </dl>
            <p className="compile__verdict-note">
              The same manifest drives the stage above, the time-coded overlay and the recap below.
            </p>
          </div>
        ) : (
          <div className="compile__verdict-bad">
            <p className="chip chip--not-implemented">
              Rejected · {String(result.errors.length)} error{result.errors.length === 1 ? '' : 's'}
            </p>
            <ul className="compile__errors" role="list">
              {result.errors.map((error, index) => (
                <li key={`${error.fieldPath}-${String(index)}`} className="compile__error">
                  <span className="mono compile__error-path">{error.fieldPath}</span>
                  <span className="chip compile__error-code mono">{error.code}</span>
                  <span className="compile__error-message">{error.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
