import { NextResponse } from 'next/server';
import { compileMomentProposal } from '@kyneloom/moment-compiler';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';

/**
 * KYN-16 — the deterministic Playable Moment compiler API
 * (`POST /api/moment/compile`).
 *
 * This is the boundary a real Microsoft Foundry agent workflow (KYN-15)
 * plugs into: an UNTRUSTED MomentProposal document goes in; the trusted
 * source context (committed synthetic fixture, current reducer revision and
 * content digest, deterministic candidates, tenant rights allowlists) is
 * assembled server-side from the current source — never from the request —
 * and the deterministic compiler adjudicates. No caching across requests: a
 * source correction must invalidate immediately (same law as the KYN-12
 * metric route).
 *
 * The response NEVER contains or mints approval: compiled output status is
 * `draft` with `approval: null`; approvals stay a server publication-service
 * workflow (docs/06 gate 7, docs/10). Authentication/tenancy is Issue #21 —
 * this route compiles only against the demo tenant's single synthetic
 * source, and nothing wider is resolvable.
 */

export const dynamic = 'force-dynamic';

/** Compiler input cap: proposals are small typed documents. */
const MAX_BODY_BYTES = 131_072;

export const COMPILE_ROUTE_VERSION = 'kyneloom-moment-compile-v1';

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: COMPILE_ROUTE_VERSION,
        errors: [
          {
            fieldPath: '(root)',
            code: 'too_long',
            message: `proposal exceeds ${String(MAX_BODY_BYTES)} bytes`,
          },
        ],
      },
      { status: 413 },
    );
  }
  let proposal: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          routeVersion: COMPILE_ROUTE_VERSION,
          errors: [
            {
              fieldPath: '(root)',
              code: 'too_long',
              message: `proposal exceeds ${String(MAX_BODY_BYTES)} bytes`,
            },
          ],
        },
        { status: 413 },
      );
    }
    proposal = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: COMPILE_ROUTE_VERSION,
        errors: [{ fieldPath: '(root)', code: 'invalid_type', message: 'body must be valid JSON' }],
      },
      { status: 400 },
    );
  }

  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: COMPILE_ROUTE_VERSION,
        errors: [
          {
            fieldPath: '(root)',
            code: 'missing_reference',
            message: `the trusted source could not be assembled: ${source.message}`,
          },
        ],
      },
      { status: 503 },
    );
  }

  const result = compileMomentProposal(proposal, source.snapshot.context);
  // Validation rejections are the endpoint doing its job correctly — they
  // return 200 with the typed error list so agents/Studio can render exact
  // field paths without parsing HTTP semantics.
  return NextResponse.json({ routeVersion: COMPILE_ROUTE_VERSION, ...result });
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      tool: 'compile_manifest',
      routeVersion: COMPILE_ROUTE_VERSION,
      method: 'POST',
      body: 'MomentProposal (docs/06, contracts/moment-proposal.ts) — schemaVersion 0.1.0',
      contract:
        'ok:true → { manifest, manifestHash, inputFingerprint, metrics, presentation, checks } — status draft, approval null; ok:false → { errors: ContractValidationError[] with exact field paths }',
      approval:
        'this endpoint can never mint an approval; publication is a separate authorized server workflow',
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
