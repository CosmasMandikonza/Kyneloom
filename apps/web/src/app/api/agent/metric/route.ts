import { NextResponse } from 'next/server';
import { ROSTERS } from '@kyneloom/match-core';
import {
  executeMetricQuery,
  parseMetricQuery,
  METRIC_TOOL_VERSION,
  type MetricToolContext,
} from '@kyneloom/match-core';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildSceneData } from '@/lib/scene-data';

/**
 * KYN-12 — the bounded read-only metric API for agents
 * (`POST /api/agent/metric`, docs/07 `get_metric`).
 *
 * Server-only resolution over the allowlisted match source. Scope today is
 * exactly the synthetic demo fixture — Issue #21's auth/tenant/licensing
 * system does not exist yet, so NOTHING broader may be resolved (no
 * guessed-id access to other sources, because no other source is
 * registered). No SQL, no paths, no URLs, no code, no freeform tool names.
 *
 * The model may READ numbers from this endpoint; it may never SUPPLY them —
 * responses carry the deterministic MetricResult with provenance and status.
 */

export const dynamic = 'force-dynamic';

/** Registered (authorized) sources. Issue #21 extends this list. */
const ALLOWED_MATCH_IDS: ReadonlySet<string> = new Set(['synthetic-derby-01']);

/** Response size cap: reject absurd payloads before parsing. */
const MAX_BODY_BYTES = 4096;

function rolesByEntity(): Map<string, string> {
  const roles = new Map<string, string>();
  for (const team of ['home', 'away'] as const) {
    for (const profile of ROSTERS[team]) {
      roles.set(profile.entityId, profile.role);
    }
  }
  return roles;
}

/**
 * REVIEW GATE 3 — NO cross-request context cache. The previous 60 s
 * matchId-keyed cache could serve stale `verified` numbers after a source
 * correction, and `revisionCount` counts applied EVENT envelopes, so a
 * tracking-only correction leaves the revision number unchanged — a
 * revision-keyed scheme would still be wrong without a full content
 * digest. This route serves one small synthetic fixture; the projection
 * is ~200 ms, so every request rebuilds the context from the CURRENT
 * accepted source. A cache may return only when it validates a full
 * source content digest AND the reducer revision.
 */
async function resolveContext(_matchId: string): Promise<MetricToolContext | null> {
  const golden = await loadGoldenMatch();
  if (!golden.ok) return null;
  const scene = buildSceneData(golden);
  if (scene === null) return null;
  const playerEntityIds = scene.players.map((player) => player.entityId);
  const context: MetricToolContext = {
    matchId: golden.data.matchId,
    reducerRevision: golden.data.projected.revisionCount,
    timeline: golden.data.projected.timeline,
    tracking: golden.data.projected.acceptedTracking,
    events: golden.data.projected.acceptedEvents,
    playerEntityIds,
    rolesByEntity: rolesByEntity(),
  };
  return context;
}

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'payload-too-large',
        detail: `body exceeds ${String(MAX_BODY_BYTES)} bytes`,
      },
      { status: 413 },
    );
  }
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          toolVersion: METRIC_TOOL_VERSION,
          code: 'payload-too-large',
          detail: `body exceeds ${String(MAX_BODY_BYTES)} bytes`,
        },
        { status: 413 },
      );
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'malformed-body',
        detail: 'body must be valid JSON',
      },
      { status: 400 },
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'malformed-body',
        detail: 'body must be a JSON object',
      },
      { status: 400 },
    );
  }
  const body = raw as Record<string, unknown>;
  const matchId = body['matchId'];
  if (typeof matchId !== 'string' || matchId.trim() === '') {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'invalid-match',
        detail: 'matchId must be a non-empty string',
      },
      { status: 400 },
    );
  }
  if (!ALLOWED_MATCH_IDS.has(matchId)) {
    // Unknown/guessed ids never reveal WHICH ids exist.
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'match-not-authorized',
        detail: 'matchId is not an available authorized source',
      },
      { status: 404 },
    );
  }

  const requestedRevision = body['reducerRevision'];
  const context = await resolveContext(matchId);
  if (context === null) {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'source-unavailable',
        detail: 'the authorized source could not be projected',
      },
      { status: 503 },
    );
  }
  if (
    requestedRevision !== undefined &&
    (typeof requestedRevision !== 'number' ||
      !Number.isInteger(requestedRevision) ||
      requestedRevision < 0)
  ) {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'invalid-revision',
        detail: 'reducerRevision must be a non-negative integer',
      },
      { status: 400 },
    );
  }
  if (typeof requestedRevision === 'number' && requestedRevision !== context.reducerRevision) {
    return NextResponse.json(
      {
        ok: false,
        toolVersion: METRIC_TOOL_VERSION,
        code: 'stale-revision',
        detail: `requested revision ${String(requestedRevision)} != current ${String(context.reducerRevision)}; re-read against the current revision`,
        currentRevision: context.reducerRevision,
      },
      { status: 409 },
    );
  }

  const parsed = parseMetricQuery(body['query']);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, toolVersion: METRIC_TOOL_VERSION, code: parsed.code, detail: parsed.detail },
      { status: 400 },
    );
  }
  const executed = executeMetricQuery(context, parsed.query);
  if (!executed.ok) {
    return NextResponse.json(executed, { status: 400 });
  }
  return NextResponse.json(executed);
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      tool: 'get_metric',
      toolVersion: METRIC_TOOL_VERSION,
      method: 'POST',
      body: {
        matchId: 'string (authorized source id)',
        reducerRevision: 'integer (optional; mismatch → 409 stale-revision)',
        query: {
          kind: 'nearest-opponent | separation-delta | passing-lane-occupancy | off-ball-movement',
          '…': 'metric-specific arguments',
        },
      },
      contract:
        'MetricResult: status verified|disclosed|insufficient-evidence; zero is a value, missing is a status; provenance + dependencies + fingerprint on every result',
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
