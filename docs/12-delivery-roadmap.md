# 12 — Delivery roadmap for a two-founder team

> **Working date:** October 12, 2026. Microsoft × Premier League submission cutoff: **October 27, 2026, 11:59 PM PT** (verify latest organizer communications). Dates are planning windows, not promises or proof of completion.

## The execution rule

**One polished working vertical slice beats a dozen unintegrated features.** We do not shrink the ambition; we structure it so each milestone delivers a demonstrable, extensible subsystem.

### Founder lanes

**A — Intelligence/platform:** fixture schema, deterministic match state, ingestion, evidence metrics, Foundry orchestration, API/persistence, Azure and test telemetry.

**B — Interactive experience:** spatial scene, pitch/asset quality, camera rig, timeline controls, evidence X-Ray, lens switching, studio layout and visual QA.

**Shared every day:** manifest contract, integration, demo reproducibility and architecture decisions.

## Milestones and exit gates

| Milestone | Target deliverable | Blocking gate |
|---|---|---|
| M0 — Contracts | Product story, match/event schema, manifest schema, UX reference frames and ADRs | Everyone can name one shared state model and the first demonstration path |
| M1 — Real replay | Three.js/R3F pitch, player/ball trajectories, scrub, orbit/follow camera, overlays, 2D fallback | Same fixture/time gives identical scene in all camera modes |
| M2 — Live intelligence | Seeded event generator → normalized stream → deterministic match reducer → client deltas | Duplicate and late-event tests pass; live view doesn't depend on Foundry |
| M3 — Experience compiler | Real Foundry calls, bounded agents, tool metrics, compiler and fact gate | Unseen supported event creates validated scene; unsupported number rejected |
| M4 — Studio & distribution | Editable shot track, audience variants, server approval, published viewer | Producer can revise, approve, open and revoke one release |
| M5 — Reliability & UX | Auth, test harness, monitoring, responsive mobile, asset load and chaos tests | Real screenshot/test/tracing evidence; no false status claims |
| M6 — Competition submission | <2 minute polished walkthrough, public repo as required, source docs, judge instructions | An independent reviewer can access and reproduce core flow |

## Suggested critical-path planning (not fixed commitments)

**Oct 12–14:** integrate M0, establish app/runtime stack, fixture generator and real 3D skeleton. Cross-team handshake: contract definitions, input sample, renderer frame.

**Oct 15–18:** finish M1/M2 and the first **truthful** end-to-end replay; make test fixtures and source ID evidence visible.

**Oct 19–22:** M3, agent/manifest compiler, first working evidence correction; a producer-visible draft.

**Oct 23–25:** M4, publishing and security, design polish across viewports, integration/reliability runs.

**Oct 26–27:** M5/M6: reproduce on clean device, capture only real features, repo/docs/test access, submit early enough to handle failures.

**Risk priority:** if time is lost, preserve factual replay → agent-supported scene draft → evidence validation → actual release. Defer photoreal crowds, long-language catalog, multiplayer, alternative worlds and speculative counterfactual modeling.

## Issue template for every task

```markdown
### User outcome
What can a real user do afterward?

### Input and output contract
What source IDs, schema versions and endpoint/state shape are involved?

### UI/behavior states
Ready, loading, empty, error, low-power, unauthorized, reduced motion.

### Tests and measurement
What proves it works? Include fixture, screenshot or trace reference.

### Definition of done
What would make a skeptical reviewer accept this as real?
```

## Integration and change discipline

- Schema changes reviewed by both founders; add migration and contract tests.
- A feature branch or small PR per vertical slice; no silent replacement of shared schema.
- Avoid two engineers independently creating an alternative state store.
- Every day, re-run the same golden fixture end-to-end.
- Screenshots are reviewed at actual viewport sizes, not assumed from local desktop.
- Keep secrets, private licenses and privileged judge credentials out of repository history.

## Definition of done for a public demonstration

A person unfamiliar with the code can: load authorized synthetic fixture; enter the moment; change perspective and time; see one verifiable fact and one labeled inference; watch a working Foundry process produce a scene; see an unsupported claim blocked; edit/approve a version; open that version in an independent viewer.

This must be documented with executed tests and trace IDs. If a step isn't implemented, describe it as planned and avoid including it as working in the submission.

**Related:** [Milestone quality](11-evaluation-and-reliability.md) · [Competition requirements](13-hackathon-submission.md) · [Contributor instructions](../AGENTS.md).