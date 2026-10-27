import { NextResponse } from 'next/server';
import { resolveAskMoment } from '@/lib/ask-intent';
import { ASK_ROUTE_VERSION, MAX_PROMPT_LENGTH, SUPPORTED_INTENTS } from '@/lib/ask-intent-shared';

/**
 * KYN "Ask Kyneloom" — `POST /api/moment/intent`.
 *
 * A BOUNDED DETERMINISTIC intent resolver (clearly labeled in every
 * response) — not Microsoft Foundry (KYN-15 owns that seam). The request is
 * a natural-language question about the compiled moment; the response is
 * grounded in the CURRENT authoritative fixture and compiled by the real
 * deterministic compiler. Never mints approval or publication permission.
 */

export const dynamic = 'force-dynamic';

/** A question, not a document. */
const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: ASK_ROUTE_VERSION,
        kind: 'invalid',
        errors: [
          {
            fieldPath: 'prompt',
            code: 'too_long',
            message: `the request exceeds ${String(MAX_BODY_BYTES)} bytes`,
          },
        ],
      },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: ASK_ROUTE_VERSION,
        kind: 'invalid',
        errors: [{ fieldPath: '(root)', code: 'malformed', message: 'the body is not valid JSON' }],
      },
      { status: 400 },
    );
  }

  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: ASK_ROUTE_VERSION,
        kind: 'invalid',
        errors: [
          {
            fieldPath: 'prompt',
            code: 'empty',
            message: 'ask a question about the moment — the prompt cannot be empty',
          },
        ],
      },
      { status: 400 },
    );
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        routeVersion: ASK_ROUTE_VERSION,
        kind: 'invalid',
        errors: [
          {
            fieldPath: 'prompt',
            code: 'too_long',
            message: `the prompt exceeds ${String(MAX_PROMPT_LENGTH)} characters`,
          },
        ],
      },
      { status: 400 },
    );
  }

  const outcome = await resolveAskMoment(prompt);
  return NextResponse.json(outcome);
}

export const SUPPORTED_EXAMPLES = SUPPORTED_INTENTS;
