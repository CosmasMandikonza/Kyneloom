# Instructions for AI coding agents and human contributors

This file governs future work inside Kyneloom. **Read it before implementing.** Product ambition does not justify inventing deployed functionality, rewriting contracts, or choosing default dashboard UI patterns.

## Start here, in order

1. [Product promise](docs/01-product-vision.md) and [canonical user journey](docs/02-experience-design.md).
2. [MomentManifest contract](docs/06-moment-manifest.md), [event envelope](docs/05-data-and-event-contracts.md), and relevant ADRs.
3. [Architecture](docs/04-system-architecture.md), [agents](docs/07-agent-orchestration.md), [3D renderer](docs/08-3d-engine.md), and [security](docs/10-security-and-rights.md).
4. **Mandatory for any UI implementation:** [source-verified frontend blueprint](docs/17-source-verified-frontend.md) → [Design rules](docs/03-design-system.md) → [visual QA](docs/16-visual-reference-and-qa.md) → [quality gates](docs/11-evaluation-and-reliability.md).
5. The exact milestone/issue being worked on in [roadmap](docs/12-delivery-roadmap.md).

## Non-negotiable principles

- **Truthful status:** Never claim a workflow, screenshot, benchmark, integration, test, deployment or customer exists unless verified in repo or runtime.
- **No fabricated sports facts:** Source-reported, synthetic, interpolated, calculated, and inferred values are distinct types. Never flatten them into a single “verified” claim.
- **No model-written arbitrary code:** Agent outputs are strongly typed, constrained data; renderer interprets allowlisted operations.
- **Deterministic football math:** State transitions, event sequencing, positions, distances and numerical statistics belong in tested code, not LLM free text.
- **Two execution paths:** the live view never synchronously waits on creative agents. See ADR-0001.
- **Least privilege:** rights/tenant/approval checks are enforced on the server; UI gating alone is insufficient.
- **Scope discipline:** solve one end-to-end user task per vertical slice. Do not generate 12 stubbed services and call it complete.

## Frontend bar

- **Scene-first, not dashboard-first.** Interactive 3D spatial scene is the fan product; producer timeline and controls are the professional product.
- **Reference → source → adapt → verify.** Read [the actual source-verified component map](docs/17-source-verified-frontend.md). Inspect the **upstream implementation and license at a pinned commit**, not merely preview links, and log source/dependency/behavior before adapting Cult UI, React Bits, Skiper UI, Codrops, Three.js/R3F effects. No visual guesswork from a screenshot alone.
- No disconnected hero animations, meaningless cards, emoji UI, generic KPI grids, needless sidebars or motion that obscures data. **Reject fan UI that resembles a research report or analytics admin panel.** The scene must dominate Explore and actual editor timeline dominate Studio.
- Design every visible state: first load, ready, playing, paused, buffering, missing tracking, inferred path, rejected claim, permission denied, export failure.
- Prove mobile usability, keyboard controls, visible focus, reduced-motion alternatives, 2D fallback and high-contrast evidence semantics.
- Test 1440×900 desktop, 1280×800 laptop, 1024×768 tablet, 390×844 and 375×812 mobile **with real rendered screenshots**; inspect for clipping, misleading camera paths and unreadable overlays. Record deviations from named references.
- Use motion to clarify time, continuity, spatial causality or editorial intent—not decorate everything.

## Changes must be auditable

For each implementation change, provide:
1. **What user outcome changed** and which milestone/issue it advances.
2. **Contract changes** (schemas/API/permissions), with backward-compatibility note.
3. **Tests run and actual results.** Do not say “all passed” without execution output.
4. **Visual verification** for UI work: viewport sizes, screenshots, found issues, fixes.
5. **Operational impact**: new secrets/services, cost or latency implications, fallbacks. For UI: include upstream source path/commit, license and screenshot/interaction comparison.
6. **Docs/status updates** when a previously planned feature is demonstrably real.

### Before writing a new dependency or service

Ask: Is it used by a demonstrable vertical slice? Is there a simpler solution? Does it create a second source of truth? Can two founders operate it? If not justified, defer.

### PR checklist

- [ ] Acceptance criteria and user journey defined
- [ ] Input/output schemas validated and versioned when applicable
- [ ] Permissions, rights and evidence provenance handled
- [ ] Unit/integration/replay tests added for meaningful behavior
- [ ] Failure/empty/retry states covered
- [ ] Performance and accessibility impact checked
- [ ] Desktop/mobile screenshots reviewed for UI changes
- [ ] README/docs status changed only with verifiable evidence

## Source hierarchy when instructions conflict

1. Security/rights constraints and documented data invariants.
2. Accepted ADRs and versioned contracts.
3. Current milestone acceptance criteria and feature spec.
4. Design-system rules and vetted references.
5. Implementation preferences.

Propose an ADR to overturn a higher-level decision; don't silently override it.

**Primary design principle:** *Build a truthful, beautiful, editable Playable Moment before building a constellation of unrelated AI features.*
