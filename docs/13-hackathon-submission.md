# 13 — Microsoft × Premier League: competition evidence plan

> **Source:** [Microsoft official rules (published in organizer GitHub)](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md). This page is an internal execution checklist, not an alternative to the rules. **No submission is claimed as complete.**

## Dates and hard requirements

- Registration: Sept 29–Oct 20, 2026 (ends noon Pacific).
- Hacking/submission: Oct 6–Oct 27, 2026 (ends **11:59 PM Pacific**).
- New solution created after registration period begins.
- Working project must function as depicted; supply **public GitHub repo**, short pitch, **public demo video under 2 minutes** and freely accessible judging/test link or build. Judges may not open the live app.
- Use synthetic football-realistic data; rights required for third-party footage, logos and audio. Public presentation must not reveal private credentials.
- Project may receive at most **one grand prize and one category prize**.

**Important now:** This repository was observed to be private on Oct 12. **A private repo does not satisfy the published public-repository submission rule**; plan a sanitized public release once secrets and licenses are reviewed. Do not flip visibility without owner authorization and a pre-public security scan.

**Competition intelligence update:** [October 13, 2026 gallery radar](20-competitive-radar-2026-10-13.md). The supplied gallery states 128 results (126 entries captured). Several explicitly describe factual agent crews and producer approvals; these cannot be claimed as Kyneloom inventions. Our required differentiator is a **real, synced 3D replay + transparent broadcast overlay + verified recap + editable approved portable moment** all from one evidence-grounded manifest. Track [#31](https://github.com/CosmasMandikonza/Kyneloom/issues/31).

## The mandatory five-stage challenge

| Organizer stage | Kyneloom target | Minimum real evidence |
|---|---|---|
| Ingest synthetic events | Seeded fixture → Azure Event Hubs ingestion | Timestamped source events and consumer trace |
| Interpret patterns | Deterministic metric engine and moment selection | Source IDs, algorithm version, replay test |
| Explain relevance | Foundry-backed tactical explanation + source-linked hypotheses | Tool trace, factual verification and editorial finding |
| Render alongside match | Synchronized 3D/2D scene and overlays | Browser capture with time-aligned event |
| Personalize output | Fan/analyst/accessible variants over one match state | Lens switch with consistent playhead and facts |

The app should additionally deliver a machine-readable release and a match recap if implemented in time; narrative generation is explicitly relevant to the challenge.

## Five judging dimensions (20% each)

| Dimension | Product demonstration | Proof in repo / cloud |
|---|---|---|
| Technical implementation | Reproducible synthetic-to-playable pipeline | Well-structured code, tests, schemas, maintainability, Azure/Fabric only where useful |
| Agentic design & innovation | Specialized bounded agents build and challenge an experience | Real Foundry workflow traces, typed handoffs, baseline evaluation |
| Real-world impact | Broadcast editor solves concrete creation and approval job | Customer hypothesis, rights-aware design, deployment path, cost/latency measurement |
| UX & presentation | Viewer enters moment, explores evidence, Studio publishes it | Working end-to-end capture, mobile usability, clear value inside 15 seconds |
| Category adherence | Demonstrable relation to selected prize category | Category-specific evidence, no unsupported claims |

## Prize-specific strategy

**Grand Prize:** excellence across all five stages, instant user understanding, meaningful football reasoning and a complete working workflow. Prefer product coherence over decorative complexity.

**Best Use of Microsoft Foundry Project:** actual Foundry-backed workflow, versioned prompts/tools/models, tracing, eval results and meaningful productivity benefit. Do not call a static flow diagram “orchestration.”

**Best Enterprise Solution Prize:** isolation, audit, human approval, data/asset rights, publish revocation and a credible customer with rights to underlying data.

**Best Multi-Agent System Prize:** distinct roles, shared typed state, handoffs, failure recovery, a task shown to be better solved than by one agent. Evaluation comparison matters.

**Best Azure Cloud Native Integration:** genuine event-driven services, reliable deployment/IaC, traces, fault injection, scaling/replay behavior and measured performance.

## Under-two-minute storyboard

| Video time | What a judge sees |
|---|---|
| 0:00–0:12 | Fictional goal, “You saw the finish. What created it?” Enter the moment |
| 0:12–0:32 | Real rigged-player 3D replay; follow an off-ball run and change camera |
| 0:32–0:47 | Evidence X-Ray: source-backed separation calculation vs labeled tactical hypothesis |
| 0:47–1:03 | **Same verified claim** appears as a synchronized on-screen overlay alongside an owned synthetic match feed; switch Fan/Analyst lens |
| 1:03–1:23 | Real Microsoft Foundry job proposes director tracks and recap; verifier rejects unsupported number |
| 1:23–1:42 | Producer actually edits a shot and overlay on a timeline; approves exact revision |
| 1:42–1:55 | Open independently published Playable Moment; show genuine trace/manifest evidence |
| 1:55–1:59 | Company thesis: compile auditable interactive sports experiences from one event stream |

This is a **planned shot list**. Every item in final footage must be captured from functioning software. If unavailable, remove it rather than stage it.

## Judge reproduction protocol (create after code exists)

`docs/JUDGE-TEST.md` (future) should specify: exact tested URL/build or clone SHA, reviewer account instructions without public secrets, one fixture/seed, steps and expected result, demo time budget, known limitations, required browser and fallback, support/contact channel. Test independently before submission.

## Evidence checklist

- [ ] Public repo with verified code, no confidential data or tokens
- [ ] Architecture matches *deployed* infrastructure
- [ ] Real Foundry trace and evaluated agent failure/revision
- [ ] Seeded fixture and event-time correction test
- [ ] Working 3D/2D viewer + transparent **broadcast-compatible** overlay on independently owned synthetic match feed + synchronized lens personalization
- [ ] Approved release openable independently
- [ ] Rights/licensing and synthetic data provenance documentation
- [ ] Two-minute video published at an approved provider
- [ ] Reviewer testing link and instructions working until judging ends
- [ ] Clear README with real screenshots only after implementation

**Related:** [Roadmap](12-delivery-roadmap.md) · [Evaluation](11-evaluation-and-reliability.md) · [Security](10-security-and-rights.md).