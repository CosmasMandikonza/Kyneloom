'use client';

import { useState, type ReactNode } from 'react';
import { ASK_RESOLVER_LABEL, SUPPORTED_INTENTS } from '@/lib/ask-intent-shared';

/**
 * "Ask Kyneloom" — the compact intent input above the playable stage. The
 * example prompts populate the SAME input and run the SAME production
 * handler as typed text. The scene stays visually dominant: one input row,
 * one primary action, three example chips, one honest status line.
 */
export interface AskPanelProps {
  readonly busy: boolean;
  readonly status: ReactNode;
  readonly onSubmit: (prompt: string) => void;
}

export function AskPanel({ busy, status, onSubmit }: AskPanelProps) {
  const [prompt, setPrompt] = useState('');

  const submit = (): void => {
    const text = prompt.trim();
    if (text.length === 0) return;
    onSubmit(text);
  };

  return (
    <section className="ask" aria-labelledby="ask-title" data-testid="ask-panel">
      <div className="ask__head">
        <h2 id="ask-title" className="ask__title">
          Ask Kyneloom
        </h2>
        <span className="chip chip--compiled mono" data-testid="ask-resolver-label">
          {ASK_RESOLVER_LABEL}
        </span>
      </div>
      <form
        className="ask__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="visually-hidden" htmlFor="ask-input">
          What would you like to understand about this moment?
        </label>
        <input
          id="ask-input"
          className="ask__input"
          type="text"
          value={prompt}
          maxLength={280}
          placeholder="What would you like to understand about this moment?"
          onChange={(event) => setPrompt(event.target.value)}
          data-testid="ask-input"
        />
        <button
          type="submit"
          className="btn btn--primary ask__go"
          disabled={busy || prompt.trim().length === 0}
          data-testid="ask-submit"
        >
          {busy ? 'Resolving…' : 'Explore moment'}
        </button>
      </form>
      <div className="ask__examples" aria-label="Example prompts">
        {SUPPORTED_INTENTS.map((intent) => (
          <button
            key={intent.id}
            type="button"
            className="ask__example"
            onClick={() => {
              setPrompt(intent.example);
              onSubmit(intent.example);
            }}
            data-testid={`ask-example-${intent.id}`}
          >
            {intent.example}
          </button>
        ))}
      </div>
      {/* Status line: grounded explanation, honest rejection, or busy —
          never fabricated support. */}
      <div className="ask__status" role="status" data-testid="ask-status">
        {status}
      </div>
    </section>
  );
}
