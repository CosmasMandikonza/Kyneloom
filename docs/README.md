# Kyneloom documentation

> **Documentation state:** Architectural and product decisions proposed on 12 October 2026. This is a source-of-truth specification for new implementation, **not evidence of features already shipped**.

## Read by what you are doing

| If you are… | Read in this order | Decision to make |
|---|---|---|
| New founder / engineer | [Vision](01-product-vision.md) → [Architecture](04-system-architecture.md) → [Roadmap](12-delivery-roadmap.md) | Which vertical slice are we completing? |
| Building the fan experience | [Experience](02-experience-design.md) → [Design system](03-design-system.md) → [3D engine](08-3d-engine.md) → [Manifest](06-moment-manifest.md) | What real input produces this interaction? |
| Building streams / backend | [Event contracts](05-data-and-event-contracts.md) → [Architecture](04-system-architecture.md) → [Azure](09-azure-platform.md) → [Reliability](11-evaluation-and-reliability.md) | What is the source of truth and failure policy? |
| Building agents | [Agent orchestration](07-agent-orchestration.md) → [Manifest](06-moment-manifest.md) → [Evidence and safety](10-security-and-rights.md) → [Evaluation](11-evaluation-and-reliability.md) | What tool-bound, testable outcome does each model generate? |
| Preparing a demo | [Experience](02-experience-design.md) → [Judging plan](13-hackathon-submission.md) → [Roadmap](12-delivery-roadmap.md) | What can a judge reproduce? |
| Coding agent | [Root instructions](../AGENTS.md) → relevant domain spec → [ADRs](decisions/0001-dual-path-architecture.md) | How do I avoid inventing features and dependencies? |

## Documentation map

**Product:** [01 Vision](01-product-vision.md) · [02 Experience](02-experience-design.md) · [03 Design](03-design-system.md)

**Contracts:** [04 Architecture](04-system-architecture.md) · [05 Events](05-data-and-event-contracts.md) · [06 Moment Manifest](06-moment-manifest.md) · [07 Agents](07-agent-orchestration.md)

**Engineering:** [08 Spatial renderer](08-3d-engine.md) · [09 Azure](09-azure-platform.md) · [10 Security & rights](10-security-and-rights.md) · [11 Evaluation](11-evaluation-and-reliability.md)

**Execution:** [12 Roadmap](12-delivery-roadmap.md) · [13 Competition](13-hackathon-submission.md) · [14 Market context](14-competitive-landscape.md) · [15 First build](15-first-vertical-slice.md) · [16 Visual QA](16-visual-reference-and-qa.md) · [References](REFERENCES.md)

**Decision log:** [ADR-0001 Two execution paths](decisions/0001-dual-path-architecture.md) · [ADR-0002 Typed manifests](decisions/0002-typed-manifest.md) · [ADR-0003 Truthful reconstruction](decisions/0003-truthful-spatial-reconstruction.md)

## Ground rules

1. **Concept is not implementation.** Update the README checklist and docs only after code, tests, or trace evidence exists.
2. **A Playable Moment is the invariant.** A producer, fan, analyst and accessible listener view one canonical match state and derived, permission-filtered renderings.
3. **Data truth precedes cinematography.** Motion, numerical facts and event sequence must not be created by an unconstrained model.
4. **AI emits specifications, not executable code.** The compiler rejects invalid schemas, unsupported facts and unauthorized operations.
5. **One product, many views.** Never replace the fan product with a technical agent dashboard.
6. **Tests and measurable quality gates** are part of any completed milestone. See [evaluation](11-evaluation-and-reliability.md).

### Changing a foundational decision

Open a design change with: the problem; alternatives; compatibility implications; security and performance consequences; test plan; rollout/migration. Record it in `docs/decisions/` and update all impacted specifications in the same change.

### Definition of a documented feature

A feature spec should say: target user, trigger, input and output contracts, state transitions, failure/empty states, accessibility behavior, trust/rights implications, tests, and measurable acceptance criteria. Unverifiable adjectives such as “real-time,” “accurate,” or “enterprise-grade” are not acceptance criteria.

[← Project README](../README.md)