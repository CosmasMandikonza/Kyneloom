# 18 — Two-founder execution board and agent prompting playbook

> **As of October 12, 2026.** This is an implementation coordination manual, not evidence the product is built. The full 30-issue backlog (KYN-00 through KYN-29) lives at **[Execution control room — issue #29](https://github.com/CosmasMandikonza/Kyneloom/issues/29)**. The official submission is due October 27, 2026, 11:59 PM Pacific, subject to organizer updates.

## How to choose the next issue

**Do not give both agents the entire project prompt.** Assign one well-defined issue to one coding agent in an isolated branch/worktree, with the explicit acceptance tests from that issue.

The first parallel assignment:

| Founder A · Intelligence & platform | Founder B · Experience & design |
|---|---|
| [#1: Runnable workspace + CI](https://github.com/CosmasMandikonza/Kyneloom/issues/1) | [#5: Tokens, shell + visual QA](https://github.com/CosmasMandikonza/Kyneloom/issues/5), coordinating scaffold imports with A |
| Joint review of [#2: Canonical contracts](https://github.com/CosmasMandikonza/Kyneloom/issues/2) | Obtain one versioned fixture sample as soon as #2 is agreed |
| [#3: Seeded football fixture](https://github.com/CosmasMandikonza/Kyneloom/issues/3) → [#4: Reducer](https://github.com/CosmasMandikonza/Kyneloom/issues/4) | [#6: Real 3D replay](https://github.com/CosmasMandikonza/Kyneloom/issues/6) → [#7: Elastic cameras](https://github.com/CosmasMandikonza/Kyneloom/issues/7) |
| [#12: Football metrics](https://github.com/CosmasMandikonza/Kyneloom/issues/12) | Integrate [#8: Evidence X-Ray](https://github.com/CosmasMandikonza/Kyneloom/issues/8) with A |
| [#13: Live events](https://github.com/CosmasMandikonza/Kyneloom/issues/13), [#15: Foundry](https://github.com/CosmasMandikonza/Kyneloom/issues/15), [#16: Compiler](https://github.com/CosmasMandikonza/Kyneloom/issues/16) | [#11: Lens system](https://github.com/CosmasMandikonza/Kyneloom/issues/11), [#17: Studio](https://github.com/CosmasMandikonza/Kyneloom/issues/17) |
| [#21: Tenant/rights](https://github.com/CosmasMandikonza/Kyneloom/issues/21) before [#18: Publish](https://github.com/CosmasMandikonza/Kyneloom/issues/18) | Hook Studio to actual compiled/approved manifest |

**Shared gating work:** [#24: golden end-to-end](https://github.com/CosmasMandikonza/Kyneloom/issues/24), [#27: independent visual direction](https://github.com/CosmasMandikonza/Kyneloom/issues/27), [#22: AI evaluation](https://github.com/CosmasMandikonza/Kyneloom/issues/22), [#25: judge-ready demo](https://github.com/CosmasMandikonza/Kyneloom/issues/25).

**Realistic animation is a release gate, not a decorative stretch:** [#30 rigged footballers, skeletal animation and cinematic stadium](https://github.com/CosmasMandikonza/Kyneloom/issues/30) is required to finish [#6 Living Replay](https://github.com/CosmasMandikonza/Kyneloom/issues/6). It can be developed in parallel with the geometry/replay data integration, after both agree on root transform ownership and sample fixtures.

**Entry architecture:** published authorized moments land in Fan view without a forced role selector. **Analyze** and accessible perspectives are opt-in inside the viewer. Professional `/studio` uses authenticated tenant/role permissions; see [experience design](02-experience-design.md) and [#11](https://github.com/CosmasMandikonza/Kyneloom/issues/11).

**Distinctive expansions:** [#9 orb/stadium](https://github.com/CosmasMandikonza/Kyneloom/issues/9), [#10 collectible gallery](https://github.com/CosmasMandikonza/Kyneloom/issues/10), [#19 SDK](https://github.com/CosmasMandikonza/Kyneloom/issues/19), [#20 audio accessibility](https://github.com/CosmasMandikonza/Kyneloom/issues/20), [#23 reliability](https://github.com/CosmasMandikonza/Kyneloom/issues/23), [#26 customer validation](https://github.com/CosmasMandikonza/Kyneloom/issues/26), [#28 parallel perspectives](https://github.com/CosmasMandikonza/Kyneloom/issues/28).

## Copy-paste instruction for either coding agent

Copy the following, replace **ISSUE_NUMBER**, and attach or paste the complete GitHub issue if the agent's GitHub access is unavailable:

```text
You are implementing Kyneloom, an evidence-native, interactive sports
experience engine. Your task is exactly issue #ISSUE_NUMBER in
CosmasMandikonza/Kyneloom; do not reinvent the product or broaden scope.

FIRST:
1. Inspect the current branch/tree and the complete issue. Read AGENTS.md,
   docs/15-first-vertical-slice.md and linked domain docs.
2. State the issue's user outcome, upstream inputs, versioned outputs,
   dependencies, source-of-truth ownership, and acceptance tests.
3. Check for existing implementation, exact dependency versions and prior
   PRs. Do not claim unimplemented services, APIs or screens are real.

IMPLEMENT:
4. Work in a dedicated branch; ship a complete vertical slice and tests.
5. Use the shared event/manifest contracts; do not create new separate
   player coordinates, timeline clocks, unsupported statistics or
   model-generated executable code.
6. For UI: inspect actual upstream component source and license from
   docs/17, render the result, iterate real desktop/mobile screenshots,
   preserve accessibility and maintain cinematic scene-first hierarchy.
7. For cloud/AI: demonstrate real service calls, bounded tools and failure
   handling. Label simulation/mocks; do not fabricate trace or benchmark data.

VERIFY:
8. Execute typecheck, lint, tests, build and applicable E2E checks.
   Include the actual outputs. Fix failures rather than asserting success.
9. Include adverse cases: missing data, stale revision, forbidden role,
   WebGL fallback, retry/correction as applicable.
10. Open a PR with concise implementation map, screenshots/video, exact
    runtime observations, known limitations and follow-up dependencies.
11. Stop on interface-breaking architecture decisions and request joint
    contract review. Never silently overwrite teammate work.
```

## Agent prompts must include the actual issue

A loose one-liner like “make the UI ultra premium” causes drift. The agent needs a specific behavior (“Follow the decoy winger at 78:42 with stable world state and source-linked positional evidence”), actual component source and measurable acceptance criterion (“at 390×844 the scene remains dominant and selection works without hover”).

**One accepted PR > many unverified tool actions.**

## Parallel development without collisions

- One issue per branch. Suggested `feat/kyn-06-living-replay`, `feat/kyn-03-synthetic-fixture`.
- Prefer separate git worktrees/clones for two coding agents. Never let both edit the same branch while autonomously writing files.
- Both founders approve changes to `packages/contracts`, world transform, manifest schema and public API semantics before merge.
- Founder A publishes minimal **versioned sample fixture** early, so Founder B does not block on full event-stream deployment.
- Merge small schema changes first, run integration tests, rebase feature branches and inspect conflicts. No force pushes to shared branch.
- After each merge, launch the same seeded 78th-minute fixture and run the actual browser.
- Agent-generated PR summaries are not evidence: verify test logs, traced network paths, screenshots and code.

## Quality stoplights

**Red — don't merge:** invented fact, fake live agent, fake 3D, insecure publish, wrong coordinate math, broken mobile, unreviewed license, rendered UI unverified.

**Amber — merge only with explicit limitation:** scaffold with blocked cloud credentials, simplified procedural locomotion, missing accessibility screen, reduced mobile visual quality. Keep disabled features visibly labeled.

**Green — release-ready:** same fixture flows through real code; time/camera/evidence remain consistent; accessible interaction; cloud/AI calls traced when enabled; authorized publish survives retry; independent viewer renders an approved release.

## Review cadence

At each integration checkpoint both founders answer:
- Which real user action became possible?
- Which canonical fixture, input hash and manifest revision prove it?
- Which screenshot/video shows the experience at desktop and mobile sizes?
- Which red-team case was run? Which still fails?
- What changed in cost/latency, cloud permissions and rights?
- What issue is unblocked next?

## Deadline and competition strategy

The public list of 84 project descriptions does **not** establish that submissions are evaluated FIFO; do not optimize for a hypothetical queue. Optimize the judge's first 15 seconds (immediately understandable product), next 80 seconds (jaw-dropping real interaction), and audit proof (Foundry, multi-agent, Azure cloud-native, enterprise governance).

Even if additional impressive features are possible, **do not sacrifice the real replay → evidence → validated compilation → edit → authorized publish path**. That path is also the foundation of the post-hackathon startup.

[Return to issue index](https://github.com/CosmasMandikonza/Kyneloom/issues/29) · [Docs home](README.md)
