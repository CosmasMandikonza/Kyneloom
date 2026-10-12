# 03 — Design system and visual quality bar

> **Purpose:** prevent generic dashboards and inconsistent AI-generated interfaces. This is a specification for the **actual working product**, not a moodboard.

## Creative direction

**Editorial precision × live broadcast cinema × spatial instrument.** The atmosphere is dark, architectural and luminous—but the controls should remain practical, quiet and highly legible.

**Design principles**

1. **Spatial primacy.** The scene occupies the main canvas in Explore. Studio's timeline and preview are dominant, not agents or charts.
2. **Meaningful motion.** Animation communicates time, causality, state or navigation. No decorative motion obscuring evidence.
3. **Contextual complexity.** Easy for newcomers, deep for analysts; details are progressively disclosed.
4. **Evidence is designed.** Source-observed, modeled and hypothetical information must not look identical.
5. **Performance is visual quality.** Smooth interaction beats expensive but choppy effects.

## Brand and interface tokens (proposed)

| Token | Value | Usage |
|---|---|---|
| `ink-950` | `#071319` | Deep canvas / cinematic frame |
| `ink-900` | `#101E27` | Main application background |
| `ink-800` | `#1B3039` | Panel surfaces |
| `line` | `#37515A` | Quiet, distinct controls |
| `mint-500` | `#51D7BD` | Active interaction / trusted observed layer |
| `mint-200` | `#C6F9E7` | Fine spatial emphasis |
| `amber-400` | `#F6BA77` | Hypotheses, cautions, spatial comparison |
| `violet-400` | `#AE98F7` | AI proposals / draft-only layers |
| `text-primary` | `#F2F8F6` | Primary foreground |
| `text-muted` | `#A8C0C5` | Supporting copy (contrast-test in context) |

**Data visual encoding:** use stroke patterns, explicit labels and legend—not only hue. Observed: solid. Interpolated: fine dotted. Inferred: dashed with “inferred” chip. Unsupported: omitted from release, surfaced in Studio QA.

**Typography:** a disciplined geometric sans for product UI (e.g., Geist or similar licensed stack); numeric/tabular forms for timestamps and measurements; occasional editorial display typography only in marketing/scene headers. Avoid illegible hairline text over footage.

## Page anatomy

**Landing:** a high-quality spatial preview that flows into the playable viewer; one clear CTA (“Enter a moment”), not a long page of speculative feature claims. Fine to use an orb or disintegrating element *only* if it becomes the match world and respects reduced motion.

**Explore:** top compact match context, edge-aligned time controller and camera selector, bottom timeline, right contextual evidence drawer (collapsible). No global sidebar that shrinks the pitch by default.

**Moment gallery:** cinematic thumbnail preview and narrative hook. A collectible card treatment is acceptable when it conveys a real moment and opens it—not as a decorative inventory.

**Studio:** broadcast preview, scrub/timeline, camera track editor, layer list, claim review, audience preview, publish controls. Professional editing conventions over elaborate visuals.

**Accessibility:** transcript and audio controls are first-class, not hidden in a settings maze.

## Source-inspired component policy

Inspect actual source, documentation, performance behavior and license before implementation. Relevant inspiration: [Cult UI](https://www.cult-ui.com/docs/components), [React Bits](https://www.reactbits.dev/), [Skiper UI](https://skiper-ui.com/components), [Codrops](https://tympanus.net/codrops/), and [React Three Fiber](https://r3f.docs.pmnd.rs/). These are **references**, not evidence that we use any library today.

**Adapt rules:**
- Write down the source component and license in the feature PR.
- Explain how the effect advances a real user action.
- Reduce duplication; one animation system per domain unless justified.
- Verify SSR boundaries, mobile performance, keyboard behavior and touch hit targets.
- Never paste an animation without verifying it in the rendered app.

## Camera and motion specification

- Camera modes must interpolate position, target and field-of-view along a controlled trajectory while retaining **the same match playhead**.
- Default cinematic transition target: perceptually smooth and under ~900 ms, adjustable after user tests. Reduced-motion mode cuts spatial travel.
- Never animate player coordinates toward invented tactical positions for aesthetics.
- Scene overlays must fade based on evidence validity and selection, not imply additional facts.

## Viewport and performance QA

**Screenshot matrix:** 1440×900; 1024×768; 390×844; portrait and landscape where relevant. Verify with browser screenshots, not code inspection alone.

**Check:** no clipped canvas or dock, headings remain legible, 3D labels don't occlude critical positions, overlays remain selectable, focus visible, no major layout shifts, playback controls usable one-handed on mobile.

**Goals:** 60 FPS capable desktop and 30 FPS midrange mobile fallback, measured after assets. The engine must dynamically lower detail and offer 2D. Those are targets, not measured performance claims.

## Exact component acceptance rubric

For each new UI surface:
1. Can a viewer identify its purpose in five seconds?
2. Is the relevant object/time/claim visible without menu spelunking?
3. Does the interaction operate on real data or documented simulation?
4. Are empty/loading/error/permission states authored?
5. Does motion preserve semantic correctness?
6. Can keyboard and touch users complete the same task?
7. Did screenshots show the expected hierarchy at all target sizes?

**Related:** [Experience](02-experience-design.md) · [3D engine](08-3d-engine.md) · [Agent rules](../AGENTS.md).