// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompilerWorkbench } from './compiler-workbench';
import type { CompileResult } from '@kyneloom/moment-compiler';
import type { CorpusEntryCard } from '@/lib/moment-compiler-service';

/**
 * KYN-16 — workbench interaction contract: entries select, the compile
 * action posts the raw proposal to the real endpoint path, and the verdict
 * panel renders EXACTLY what the compiler returned (field-path errors or the
 * hashed manifest) — never an improvised client-side judgement.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Structural stand-ins for a full compile result (the panel renders these fields).
const validResult = {
  ok: true as const,
  manifest: {
    manifestId: 'mom-demo',
    status: 'draft',
    approval: null,
  },
  manifestHash: 'sha256:' + 'a'.repeat(64),
  inputFingerprint: 'fp',
  proposalOrigin: 'local-deterministic' as const,
  metrics: [{ kind: 'separation-delta', algorithmVersion: 'kyneloom-separation-v1' }],
  presentation: { broadcast: [{}, {}, {}], recap: { headline: 'h', lines: [] } },
  checks: [{ id: 'reference-existence', status: 'passed' as const }],
} as unknown as CompileResult;

const invalidResult = {
  ok: false as const,
  errors: [
    {
      fieldPath: 'claims[0].metricAssertion.assertedValue',
      code: 'unsupported_claim',
      message: 'asserted 14 but the deterministic recomputation is 23.063',
    },
  ],
} as unknown as CompileResult;

function entries(): CorpusEntryCard[] {
  return [
    {
      id: 'golden',
      label: 'Well-formed proposal',
      description: 'should compile',
      expect: 'valid',
      proposal: { schemaVersion: '0.1.0' },
    },
    {
      id: 'defect-false-distance',
      label: 'False distance claim',
      description: 'should reject',
      expect: 'invalid',
      expectedCode: 'unsupported_claim',
      proposal: { schemaVersion: '0.1.0', tampered: true },
    },
  ];
}

function stubFetch(payload: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })),
  );
}

describe('CompilerWorkbench', () => {
  it('renders the initial valid verdict without any request', () => {
    render(<CompilerWorkbench entries={entries()} initialResult={validResult} />);
    expect(screen.getByText('Compiled')).toBeTruthy();
    expect(screen.getByText('sha256:' + 'a'.repeat(64))).toBeTruthy();
    expect(document.querySelector('[data-verdict="valid"]')).not.toBeNull();
  });

  it('selects a defect, compiles it through the endpoint and renders the typed errors', async () => {
    stubFetch(invalidResult);
    render(<CompilerWorkbench entries={entries()} initialResult={validResult} />);
    fireEvent.click(screen.getByRole('button', { name: /False distance claim/ }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    await waitFor(
      () => {
        expect(document.querySelector('[data-verdict="invalid"]')).not.toBeNull();
      },
      { timeout: 6000 },
    );
    expect(screen.getByText('claims[0].metricAssertion.assertedValue')).toBeTruthy();
    expect(screen.getByText('unsupported_claim')).toBeTruthy();
    expect(
      screen.getByText(/asserted 14 but the deterministic recomputation is 23.063/),
    ).toBeTruthy();
    // The raw proposal document was posted to the real boundary verbatim.
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(call[0]).toBe('/api/moment/compile');
    const init = call[1] as { body?: unknown };
    expect(String(init.body)).toContain('"tampered":true');
  });

  it('shows an honest notice when the endpoint itself fails — no fabricated verdict', async () => {
    stubFetch({}, false);
    render(<CompilerWorkbench entries={entries()} initialResult={validResult} />);
    fireEvent.click(screen.getByRole('button', { name: /False distance claim/ }));
    fireEvent.click(screen.getByTestId('compile-proposal'));
    await waitFor(
      () => {
        expect(screen.getByText(/answered 500/)).toBeTruthy();
      },
      { timeout: 6000 },
    );
    // The verdict panel still shows the LAST real result, unchanged.
    expect(document.querySelector('[data-verdict="valid"]')).not.toBeNull();
  });
});
