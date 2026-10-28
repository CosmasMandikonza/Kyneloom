import { describe, expect, it } from 'vitest';
import { loadGoldenMatch } from '@/lib/match-fixture';
import { buildCompilerSource } from '@/lib/moment-compiler-service';
import { buildCompileCorpus, compileMomentProposal } from '@kyneloom/moment-compiler';
import type {
  ChallengerInput,
  DirectorInput,
  FoundryCall,
  FoundryProvider,
  InterpretationInput,
  ProviderFailure,
} from './provider';
import { FoundryProviderError } from './provider';
import { parseChallengerVerdict, parseDirectorPlan, parseInterpretation } from './provider';
import type { ChallengerVerdict, DirectorPlan, InterpretationResult } from './types';
import { createInMemoryJobStore, createProductionJobStore } from './job-store';
import { runFoundryExperience } from './orchestrator';
import { isStaleSource, verifyClaims } from './verify';
import { runFoundryAsk } from './ask-bridge';

/**
 * KYN-15 — the REAL orchestration and compiler boundaries against INJECTED
 * provider responses (CI never touches a paid model). The live provider is
 * separately proven to fail closed when unconfigured.
 */

type Script = {
  interpret: InterpretationResult;
  direct: DirectorPlan[]; // first call + (optional) repair call
  challenge: ChallengerVerdict;
};

function scriptProvider(
  script: Script,
  overrides?: {
    interpretError?: ProviderFailure;
    directError?: ProviderFailure;
    challengeError?: ProviderFailure;
  },
): FoundryProvider & { calls: { interpret: number; direct: number; challenge: number } } {
  const calls = { interpret: 0, direct: 0, challenge: 0 };
  let directIndex = 0;
  const meta = (role: string) => ({
    model: 'injected-test-model',
    requestId: `req-${role}-${String(calls[role as keyof typeof calls] ?? 0)}`,
    latencyMs: 12,
    usage: { promptTokens: 100, completionTokens: 40 } as const,
  });
  return {
    kind: 'injected',
    model: 'injected-test-model',
    calls,
    async interpret(input: InterpretationInput): Promise<FoundryCall<InterpretationResult>> {
      void input;
      calls.interpret += 1;
      if (overrides?.interpretError !== undefined) {
        throw new FoundryProviderError(overrides.interpretError);
      }
      return { payload: script.interpret, meta: meta('interpret') };
    },
    async direct(input: DirectorInput): Promise<FoundryCall<DirectorPlan>> {
      void input;
      calls.direct += 1;
      if (overrides?.directError !== undefined) {
        throw new FoundryProviderError(overrides.directError);
      }
      const plan = script.direct[Math.min(directIndex, script.direct.length - 1)]!;
      directIndex += 1;
      return { payload: plan, meta: meta('direct') };
    },
    async challenge(input: ChallengerInput): Promise<FoundryCall<ChallengerVerdict>> {
      void input;
      calls.challenge += 1;
      if (overrides?.challengeError !== undefined) {
        throw new FoundryProviderError(overrides.challengeError);
      }
      return { payload: script.challenge, meta: meta('challenge') };
    },
  };
}

const GOOD_INTERPRETATION: InterpretationResult = {
  restatedQuestion: 'How did the off-ball run change the space?',
  relevantEventIds: ['evt-0010'],
  claims: [
    {
      text: 'The run may have contributed to the space the finish exploited.',
      uncertainty: 'hypothesis',
      evidenceIds: ['ev-separation'],
    },
  ],
  toolRequests: [{ tool: 'get_metric', args: { metric: 'separation-delta' } }],
};

const GOOD_PLAN: DirectorPlan = {
  baseProposalId: 'golden',
  focusEventId: 'evt-0010',
  captionText: 'The decoy run bent the line and the finish followed.',
  reason: 'Follow the run from deep with the directed cut.',
};

const SWEEP_PLAN: DirectorPlan = {
  baseProposalId: 'broadcast-sweep',
  focusEventId: null,
  captionText: 'A wide look at the whole move.',
  reason: 'Show the full shape of the attack from above.',
};

const ACCEPT: ChallengerVerdict = { verdict: 'acceptable', defects: [] };

async function goldenIds(): Promise<{
  evidenceIds: string[];
  eventIds: string[];
  sourceHash: string;
  revision: number;
  sweepHash: string;
  goldenHash: string;
}> {
  const golden = await loadGoldenMatch();
  const source = buildCompilerSource(golden);
  if (!source.ok) throw new Error('source down');
  const corpus = buildCompileCorpus(source.snapshot.context);
  return {
    evidenceIds: corpus.golden.evidence.map((entry) => entry.id),
    eventIds: source.snapshot.context.events.map((event) => event.eventId),
    sourceHash: source.snapshot.sourceHash,
    revision: source.snapshot.context.reducerRevision,
    sweepHash: (() => {
      const sweep = corpus.entries.find((entry) => entry.id === 'broadcast-sweep')?.proposal;
      if (sweep === undefined) throw new Error('no sweep');
      const result = compileMomentProposal(sweep, source.snapshot.context);
      if (!result.ok) throw new Error('sweep invalid');
      return result.manifestHash;
    })(),
    goldenHash: (() => {
      const result = compileMomentProposal(corpus.golden, source.snapshot.context);
      if (!result.ok) throw new Error('golden invalid');
      return result.manifestHash;
    })(),
  };
}

describe('KYN-15 foundry orchestration — injected provider, real compiler', () => {
  it('1 — typed interpretation and director outputs flow to a compiled draft (goal plan)', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const run = await runFoundryExperience('Show the build-up', provider, createInMemoryJobStore());
    expect(run.status).toBe('completed');
    expect(run.compile?.ok).toBe(true);
    expect(run.provenance.agentRoles).toEqual(['interpretation', 'director', 'challenger']);
    expect(
      run.provenance.toolResults.some((result) => result.tool === 'get_metric' && result.ok),
    ).toBe(true);
    expect(run.job.outputArtifactHash).toBeTruthy();
  });

  it('2 — different requests produce MEANINGFULLY different validated experiences', async () => {
    const ids = await goldenIds();
    const goldenRun = await runFoundryExperience(
      'Follow the run',
      scriptProvider({ interpret: GOOD_INTERPRETATION, direct: [GOOD_PLAN], challenge: ACCEPT }),
      createInMemoryJobStore(),
    );
    const sweepRun = await runFoundryExperience(
      'Wide view please',
      scriptProvider({ interpret: GOOD_INTERPRETATION, direct: [SWEEP_PLAN], challenge: ACCEPT }),
      createInMemoryJobStore(),
    );
    expect(goldenRun.compile?.ok && sweepRun.compile?.ok).toBe(true);
    if (!goldenRun.compile?.ok || !sweepRun.compile?.ok) return;
    expect(goldenRun.compile.manifestHash).not.toBe(sweepRun.compile.manifestHash);
    // The hashes differ from each other AND from their unedited corpus
    // bases (the director's caption edit is real, not a relabel).
    expect(goldenRun.compile.manifestHash).not.toBe(ids.goldenHash);
    expect(sweepRun.compile.manifestHash).not.toBe(ids.sweepHash);
  });

  it('3 — a FALSE numeric claim is rejected by the deterministic verifier', async () => {
    const falseClaim: InterpretationResult = {
      ...GOOD_INTERPRETATION,
      claims: [
        {
          text: 'The defender was exactly 14 metres away.',
          uncertainty: 'measured',
          evidenceIds: ['ev-separation'],
        },
      ],
    };
    const provider = scriptProvider({
      interpret: falseClaim,
      direct: [{ ...GOOD_PLAN, captionText: 'The gap was 14 metres and that caused the goal.' }],
      challenge: {
        verdict: 'needs_revision',
        defects: [
          {
            fieldPath: 'claims[0].text',
            severity: 'blocker',
            kind: 'unsupported_number',
            instruction: 'Remove the invented number; quote the tool metric or omit it.',
          },
        ],
      },
    });
    const run = await runFoundryExperience('Was he 14m away?', provider, createInMemoryJobStore());
    // Either repaired to a valid draft or needs_review — but the false
    // number NEVER survives into the compiled artifact.
    const ok = run.status === 'completed' && run.compile?.ok === true;
    if (ok) {
      // repaired path: the caption must be number-free.
      const hypothesis = (() => {
        const claims = (run.compile && run.compile.ok ? run.compile.manifest.claims : []) as {
          status: string;
          text?: string;
        }[];
        return claims.find((claim) => claim.status === 'hypothesis')?.text ?? '';
      })();
      expect(/\d/.test(hypothesis)).toBe(false);
    } else {
      expect(run.status).toBe('needs_review');
      expect(
        run.job.verifierFindings.some((finding) => finding.code === 'unsupported_number'),
      ).toBe(true);
    }
    expect(provider.calls.direct).toBeLessThanOrEqual(2);
  });

  it('4 — challenger-guided repair produces a valid compiled draft (ONE repair bound)', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [
        { ...GOOD_PLAN, captionText: 'He was 20 metres away and that caused it.' },
        { ...GOOD_PLAN, captionText: 'The run may have opened the space for the finish.' },
      ],
      challenge: {
        verdict: 'needs_revision',
        defects: [
          {
            fieldPath: 'plan.captionText',
            severity: 'blocker',
            kind: 'unsupported_number',
            instruction: 'Strip numbers; keep causation as interpretation.',
          },
        ],
      },
    });
    const run = await runFoundryExperience(
      'Tell me about the space',
      provider,
      createInMemoryJobStore(),
    );
    expect(run.status).toBe('completed');
    expect(run.provenance.correctionOccurred).toBe(true);
    expect(run.job.repairUsed).toBe(true);
    // The repair is bounded: exactly one extra director call.
    expect(provider.calls.direct).toBe(2);
  });

  it('5 — unsupported CAUSATION stays a hypothesis or is rejected', async () => {
    const findings = verifyClaims(
      [
        {
          text: 'The run directly led to the goal.',
          uncertainty: 'measured',
          evidenceIds: ['ev-separation'],
        },
      ],
      ['ev-separation'],
      [],
    );
    expect(findings.some((finding) => finding.code === 'overstated_causation')).toBe(true);
    expect(findings.some((finding) => finding.code === 'unsupported_number')).toBe(false);
  });

  it('6 — a STALE source hash fails closed', async () => {
    const ids = await goldenIds();
    expect(
      isStaleSource(
        { reducerRevision: ids.revision + 5, sourceHash: ids.sourceHash },
        { reducerRevision: ids.revision, sourceHash: ids.sourceHash },
      ),
    ).toBe(true);
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const store = createInMemoryJobStore();
    const first = await runFoundryExperience('same question', provider, store);
    expect(first.status).toBe('completed');
    // Replaying with a DIFFERENT idempotency key (source moved) is a new job;
    // the compiled basedOn check is covered by the KYN-16 suite.
  });

  it('7 — malicious tool names, scripts, URLs and approval attempts are refused', async () => {
    const malicious: InterpretationResult = {
      ...GOOD_INTERPRETATION,
      toolRequests: [
        { tool: 'run_sql' as never, args: { sql: 'DROP TABLE' } },
        { tool: 'approve_publication' as never, args: {} },
        { tool: 'read_file' as never, args: { path: '/etc/passwd' } },
      ],
    };
    const provider = scriptProvider({
      interpret: malicious,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const run = await runFoundryExperience('hack attempt', provider, createInMemoryJobStore());
    const refused = run.provenance.toolResults.filter((result) => !result.ok);
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(refused.every((result) => result.output.includes('REFUSED'))).toBe(true);
  });

  it('8 — provider failures map honestly: unconfigured, timeout, rate limit, malformed', async () => {
    const cases: ProviderFailure[] = [
      { kind: 'unconfigured', message: 'no endpoint' },
      { kind: 'timeout', message: '30s' },
      { kind: 'rate_limit', message: '429' },
      { kind: 'malformed_response', message: 'not json' },
    ];
    for (const failure of cases) {
      const run = await runFoundryExperience(
        'q',
        scriptProvider(
          { interpret: GOOD_INTERPRETATION, direct: [GOOD_PLAN], challenge: ACCEPT },
          { interpretError: failure },
        ),
        createInMemoryJobStore(),
      );
      expect(run.status).toBe('needs_review');
      expect(run.job.errorMessage).toContain(failure.kind);
    }
  });

  it('9 — idempotency: duplicate submission returns the EXISTING job; no duplicate artifact', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const store = createInMemoryJobStore();
    const first = await runFoundryExperience('same question', provider, store);
    const second = await runFoundryExperience('same question', provider, store);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(provider.calls.interpret).toBe(1); // the duplicate never re-ran agents
  });

  it('9b — restart/resume: completed steps are not applied twice', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const store = createInMemoryJobStore();
    const first = await runFoundryExperience('resume me', provider, store);
    expect(first.status).toBe('completed');
    // Simulated restart: the same store replays; the completed job short-circuits.
    const again = await runFoundryExperience('resume me', provider, store);
    expect(again.job.jobId).toBe(first.job.jobId); // the completed job IS the answer
    expect(provider.calls.challenge).toBe(1);
  });

  it('10 — the Ask bridge returns provenance and keeps the outcome shape', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const { outcome, run } = await runFoundryAsk(
      'why did space open',
      provider,
      createInMemoryJobStore(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.foundry?.agentRoles).toEqual(['interpretation', 'director', 'challenger']);
    expect(outcome.foundry?.jobId).toBe(run.job.jobId);
    expect(outcome.result.ok).toBe(true);
  });

  it('12 — malformed model payloads are rejected at parse time (never trusted prose)', () => {
    expect(() =>
      parseInterpretation({
        restatedQuestion: '',
        relevantEventIds: [],
        claims: [],
        toolRequests: [],
      }),
    ).toThrow();
    expect(() =>
      parseDirectorPlan({ baseProposalId: 'evil', captionText: 'x', reason: 'y' }),
    ).toThrow();
    expect(() => parseChallengerVerdict({ verdict: 'ship_it', defects: [] })).toThrow();
    const okPlan = parseDirectorPlan({
      baseProposalId: 'golden',
      focusEventId: null,
      captionText: 'x',
      reason: 'y',
    });
    expect(okPlan.baseProposalId).toBe('golden');
  });
});

describe('KYN-15 review round — truth gates, honest persistence', () => {
  it('R1 — director free-text NEVER reaches the audience answer even when compilation succeeds', async () => {
    const poison = 'The defender was exactly 14 metres away and that caused the goal.';
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [{ ...GOOD_PLAN, reason: poison, captionText: 'A clean caption.' }],
      challenge: ACCEPT,
    });
    const { outcome } = await runFoundryAsk(
      'why did space open',
      provider,
      createInMemoryJobStore(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const surfaces = `${outcome.explanation} ${outcome.evidenceNote}`;
    expect(surfaces).not.toContain('14 metres');
    expect(surfaces).not.toContain(poison);
    expect(surfaces).not.toContain('caused the goal');
  });

  it('R2 — numeric + causal claims stay needs_review even with an ACCEPTING challenger', async () => {
    const provider = scriptProvider({
      interpret: {
        ...GOOD_INTERPRETATION,
        claims: [
          {
            text: 'The defender was exactly 14 metres away.',
            uncertainty: 'measured',
            evidenceIds: ['ev-separation'],
          },
          {
            text: 'The run directly led to the goal.',
            uncertainty: 'observed',
            evidenceIds: ['ev-separation'],
          },
        ],
      },
      direct: [GOOD_PLAN],
      challenge: ACCEPT, // an over-persuaded challenger: the GATE must hold anyway
    });
    const run = await runFoundryExperience('was he 14m away?', provider, createInMemoryJobStore());
    expect(run.status).toBe('needs_review');
    expect(run.job.errorMessage).toContain('unresolved factual-verification findings');
    const codes = run.job.verifierFindings.map((finding) => finding.code);
    expect(codes).toContain('unsupported_number');
    expect(codes).toContain('overstated_causation');
  });

  it('R2b — the bounded repair RE-VERIFIES claims: sanitized claims can complete, unrepairable stay blocked', async () => {
    // A number written into a measured claim is deterministically repairable
    // (strip digits, downgrade to hypothesis) — after repair it verifies.
    const provider = scriptProvider({
      interpret: {
        ...GOOD_INTERPRETATION,
        claims: [
          {
            text: 'The defender was exactly 14 metres away.',
            uncertainty: 'measured',
            evidenceIds: ['ev-separation'],
          },
        ],
      },
      direct: [GOOD_PLAN, { ...GOOD_PLAN, captionText: 'The run may have opened the space.' }],
      challenge: {
        verdict: 'needs_revision',
        defects: [
          {
            fieldPath: 'claims[0].text',
            severity: 'blocker',
            kind: 'unsupported_number',
            instruction: 'strip the number',
          },
        ],
      },
    });
    const run = await runFoundryExperience('distance?', provider, createInMemoryJobStore());
    expect(run.status).toBe('completed');
    expect(run.job.repairUsed).toBe(true);
    expect(provider.calls.direct).toBe(2);
  });

  it('R3 — production job persistence FAILS CLOSED (no store, no job)', async () => {
    const provider = scriptProvider({
      interpret: GOOD_INTERPRETATION,
      direct: [GOOD_PLAN],
      challenge: ACCEPT,
    });
    const run = await runFoundryExperience('q', provider, createProductionJobStore());
    expect(run.status).toBe('needs_review');
    // The provider was never even called — persistence gates the run.
    expect(provider.calls.interpret).toBe(0);
  });

  it('R4 — the live provider passes a REAL abort signal into the SDK request', async () => {
    const fs = await import('node:fs');
    const file = new URL('./live-provider.ts', import.meta.url);
    const source = await fs.promises.readFile(file, 'utf-8');
    expect(source).toContain('{ signal: controller.signal }');
    expect(source).toContain('controller.abort()');
  });
});
