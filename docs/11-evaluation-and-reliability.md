# 11 — Quality, evaluation and reliability plan

> **Status:** Proposed evaluation harness and targets; none of the numerical targets below represent achieved measurements.

## Test pyramid

| Scope | Test method | Required evidence |
|---|---|---|
| Pure reducers and geometry | Seeded unit/property tests | Deterministic outputs and invariant coverage |
| Schemas/compiler | Valid/invalid fixtures, fuzzing and snapshot tests | Typed errors and version compatibility |
| Ingestion | Out-of-order/duplicate/correction replay | Exact event and state revisions |
| Agents/tools | Grounded scripted scenarios and evaluation dataset | Verified traces, tool authorization, comparison with baseline |
| Publication/auth | Tenant/role/rights E2E tests | Forbidden actions blocked; no duplicate publish |
| 3D renderer | Deterministic frame snapshots, interaction tests and screenshot review | Frame-time and source-position agreement |
| Whole system | 1-click synthetic event → viewer → Studio → release | Independent judge can reproduce same outcome |

## Golden test fixture

A fully seeded 78th-minute fictional sequence: winger run, tracking window, pass, goal, and defensive spacing metric. Include a late correction, missing sample region and an unsupported proposed number. Archive canonical input and expected reducer output in code once implementation begins.

Use test fixtures with stable source IDs, generator version and immutable expected hashes. Do not rely on a hosted AI model returning identical prose in every test; validate structure and factual constraints, and evaluate wording statistically/offline.

## Fault-injection suite

1. Send same goal event three times; score/release unchanged after first acceptance.
2. Reverse delivery of pass and shot events; final replay projection remains correct under defined late-event policy.
3. Remove positional samples; renderer falls back safely, claims requiring them are blocked.
4. Change player ID halfway; identity confidence labeled and downstream dependency invalidated.
5. Fail agent worker after scene plan; durable replay resumes without duplicated publication.
6. Inject false numerical claim; deterministic verifier rejects it with source IDs.
7. Attempt cross-tenant publication with valid draft ID but wrong principal; 403.
8. Revoke a released moment; protected manifest/assets stop serving to revoked audience.
9. Edit stale manifest revision; conflict, not lost update.
10. Load low-powered viewport; degrade gracefully to simpler geometry or 2D.

## Proposed service-level objectives (refine after measurement)

| Indicator | Initial engineering target | How to measure |
|---|---|---|
| Accepted event → connected client update | p95 < 750 ms in specified dev fixture | End-to-end event/ack correlation |
| Renderer | 60 FPS capable desktop / 30 FPS mobile fallback | Device-labeled frame time p95 |
| Numerical objective claim verification | 100% before release (policy invariant) | Structural validation + negative tests |
| Duplicate release on retries | 0 in suite | Publish DB/outbox inspection |
| Replay consistency | Identical reducer outputs for same versioned input | Deterministic checksum |
| Agent usefulness | Beat single-agent/template baseline on blinded usefulness | Same scenarios, human ratings |
| Manifest compilation | p50/p95 tracked before setting SLO | Timer from input hash to valid draft |
| Tenant isolation | 0 unauthorized access success in suite | Negative API E2E tests |

Do not claim these benchmarks before they are demonstrated. Separate measured infrastructure latency from video/GPU rendering and model latency.

## Agent evaluation

Create ~20–30 synthetic scenarios *initially* (clean goal, defensive run, ambiguous causality, late tracking, contradictory descriptions, multilingual variants and failed tools). Each scenario specifies expected facts, claims allowed only as hypotheses, forbidden claims, feasible scene plans and review behavior.

Compare:
- Template-only baseline
- One model with typed tools
- Specialized workflow with challenge/repair

**Score dimensions:** verifiable fact coverage, unsupported claims, tactical usefulness rated blind, camera-plan feasibility, tool failure recovery, p95 latency, tokens and dollar cost. Publish **real measured results and methodology**, including failures.

## Visual acceptance and accessibility

Screenshots at 1440×900, 1024×768 and 390×844 under fan, analyst, producer, missing-data, low-power and reduced-motion conditions. Test selection, camera transitions and claim provenance. Keyboard and touch must complete main flow; captions and transcript provide equivalent explanations.

## Reproducibility

Pin fixtures, versions, seed, schema, compile hash, environment, git SHA and trace ID. CI should re-run deterministic core tests without depending on a paid Azure environment; cloud integration tests can run on selected branches/manual jobs with explicit cost controls.

## Evidence package for reviewers

Include real CI run and commit link, real frame/performance captures, traces of an actual agent correcting a false claim, redacted security tests, an Azure infrastructure diagram matching deployed resources and a single reproducible test scenario. Mark mocks or unavailable services explicitly.

**Related:** [Hackathon requirements](13-hackathon-submission.md) · [Roadmap](12-delivery-roadmap.md) · [Security](10-security-and-rights.md).