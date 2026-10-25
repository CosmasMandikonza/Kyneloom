import { describe, expect, it } from 'vitest';
import { buildCompileCorpus } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { POST } from './route';

/**
 * KYN-16 — the compile API boundary. Real pipeline, real route handler:
 * a valid proposal compiles to the pinned hash; the false-claim defect
 * returns typed field-path errors; malformed bodies fail closed without
 * touching the source.
 */

async function corpusForRoute() {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error(`source unavailable: ${source.message}`);
  return buildCompileCorpus(source.snapshot.context);
}

function requestWith(body: unknown): Request {
  return new Request('http://localhost/api/moment/compile', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/moment/compile', () => {
  it('compiles the golden corpus proposal to the pinned hash', async () => {
    const corpus = await corpusForRoute();
    const response = await POST(requestWith(corpus.golden));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      manifestHash: string;
      manifest: { status: string; approval: unknown };
    };
    expect(payload.ok).toBe(true);
    expect(payload.manifestHash).toBe(
      'sha256:88a9f0d1789a329da4f9e0963968e4e53844adcbcc00e7ec20f580c8296e6952',
    );
    expect(payload.manifest.status).toBe('draft');
    expect(payload.manifest.approval).toBeNull();
  });

  it('rejects the false-distance defect with the exact field path (200, typed errors)', async () => {
    const corpus = await corpusForRoute();
    const defect = corpus.entries.find((entry) => entry.id === 'defect-false-distance');
    expect(defect).toBeDefined();
    const response = await POST(requestWith(defect!.proposal));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      errors: { fieldPath: string; code: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors.some((error) => error.code === 'unsupported_claim')).toBe(true);
    expect(
      payload.errors.some((error) => error.fieldPath === 'claims[0].metricAssertion.assertedValue'),
    ).toBe(true);
  });

  it('fails closed on a malformed body (400, no source involved)', async () => {
    const response = await POST(requestWith('this is not json'));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; errors: unknown[] };
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it('rejects a proposal for another tenant (200, typed cross-tenant error)', async () => {
    const corpus = await corpusForRoute();
    const response = await POST(requestWith({ ...corpus.golden, tenantId: 'rival-org' }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      errors: { code: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors.some((error) => error.code === 'cross_tenant_reference')).toBe(true);
  });
});
