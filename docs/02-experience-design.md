# 02 — Experience design: one moment, multiple lenses

> **Status:** Target interactions, not current software screenshots.

## Information architecture

The product has four primary surfaces—not four separate products:

\`\`\`mermaid
flowchart LR
 Home["Match / moment discovery"] --> Player["Living Moment viewer"]
 Player --> Lens["Fan · Analyst · Accessible lens"]
 Player --> Evidence["Evidence X-Ray"]
 Player --> Studio["Studio (permission gated)"]
 Studio --> Review["Review & approve"]
 Review --> Deliver["Published playable moment"]
\`\`\`

**Public/unprivileged:** match timeline, moment gallery, fan/analyst/accessible lens, player controls, evidence panel.

**Privileged studio:** scene composition, annotations, asset selection, QA findings, approvals, publishing destinations, audit/history.

**Admin:** organizations, data rights, roles, destination rules. Never blend admin screens into fan navigation.

## The hero journey: "The invisible assist"

Fictional match fixture, 78:42. The goal is not a magical stat widget. It is a story that *becomes explorable*.

| Step | Viewer sees | Viewer does | System outcome |
|---|---|---|---|
| 1. Open | Wide cinematic pitch with active 78:42 moment and concise hook | Click **Enter moment** | Bounded timeline and camera keyframes load |
| 2. Orient | Overhead establishing shot: attackers, defenders and ball | Play / pause / scrub / select player | Same sampled match state at time \`t\` |
| 3. Discover | Off-ball run glows subtly; lane outline appears | Select run; follow camera | Timeline-linked geometry and claim reference |
| 4. Verify | “Defender separation increased” measurement with source samples | Press **Show evidence** | Raw/source frame IDs, equation, coverage and data provenance |
| 5. Interpret | “Likely opened passing space” presented as interpretation | Switch Analyst lens | Additional metric detail; no silent change to facts |
| 6. Compose | Studio shot sequence, generated caption and audience variants | Producer adjusts camera and overlays | Revised draft manifest created |
| 7. Ship | Side-by-side approved preview and exported playable view | Approve, publish, open output | Immutable, access-checked release version |

The experience must be understandable *without* the agent-trace view. Technical details are available in Studio.

## Entry model: role versus lens

**Authentication role** governs whether the person can edit, annotate, approve or administer.

**Lens** governs rendering level and storytelling style. Switch lenses within the same moment; preserve current time and selected player where sensible.

| Lens | On-screen priority | Never hide |
|---|---|---|
| Fan | Action, drama, simple “why it matters” language | Truth status, replay time and evidence affordance |
| Analyst | Defensive spacing, pressure, labels, positional sample quality | Which values are measured and which are inferred |
| Accessible | Spatially precise audio description, transcripts, adjustable pace | Equivalent controls and uncertainty announcements |
| Producer preview | Safe areas, shot duration, scene-layer stack, approval warnings | Evidence and permission state |

## Interaction grammar

- **Primary input:** play/pause, timeline scrub, select a player or event, zoom/orbit camera, follow player, show/hide evidence, lens toggle.
- **Camera:** \`Overhead\`, \`Broadcast\`, \`Player follow\`, \`Goalkeeper\`, \`Free orbit\`; mode change preserves playhead and gently interpolates unless reduced motion is enabled.
- **Selection:** a single canonical object ID; selection remains stable across cameras and lenses.
- **Evidence:** clicking a highlighted claim opens a precise source window and explanatory method; raw points and modeled curves are rendered distinctly.
- **Studio:** editing always creates a *draft revision*; approval refers to an exact revision/hash.

## Golden-path storyboard

**00–10 s:** open match, see key moment badge, press Enter.

**10–30 s:** jump into real 3D replay, free camera, follow off-ball run, pause; show evidence.

**30–45 s:** switch to Analyst lens at same timestamp; compare measured geometry versus hypothesis.

**45–70 s:** producer enters Studio, AI proposes camera/overlays; one weak claim is rejected.

**70–95 s:** edit shot and recompile; approve corrected release; open independent viewer.

This is a *demonstration goal*; do not record as working functionality until integrated and tested.

## Required states

| State | Must communicate / do |
|---|---|
| No fixture | Clear explanation and load-sample option |
| Stream connecting | Last accepted state, connection health and a rejoin path |
| Tracking absent | 2D events-only fallback and “positional reconstruction unavailable” |
| Inferred/extrapolated samples | Distinct dashed styling and source quality notice |
| Camera asset loading | Nonblocking skeleton and 2D fallback |
| Unsupported claim | Remove the claim, explain why in Studio; never show it as verified |
| Editing conflict | Revision conflict and compare/refresh, not last-write-wins |
| Approval forbidden | Explicit role/rights reason and an authorized next step |
| Publication revoked | Existing links refuse unauthorized content; show neutral notice |
| Mobile low-power | Reduced draw load, simplified layers and legible controls |

## Accessibility acceptance

Keyboard equivalents for orbit/follow/scrub (not solely pointer gestures); visible focus; accessible names; no meaning encoded only in color; subtitles/transcripts; reduced motion; audio controls; usable fallback on devices that cannot run WebGL. Target WCAG 2.2 AA for conventional UI, testing applicable 3D controls for equivalent accessible operation.

## UX guardrails

1. The scene is the product, not the dashboard.
2. No ungrounded “player psychology” claims.
3. A fan should discover their first meaningful interaction in one deliberate click.
4. Show context **on demand**, without permanently taking half the screen.
5. Navigation, layers, and selected object remain consistent between perspective changes.

**Next:** [Design system](03-design-system.md) · [3D engine](08-3d-engine.md) · [Manifest](06-moment-manifest.md).