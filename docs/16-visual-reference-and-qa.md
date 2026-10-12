# 16 — Visual execution: reference → implementation → screenshot QA

> **Scope:** actionable frontend engineering procedure. The linked libraries are *references to inspect*, not installed dependencies.

## Experience-quality hierarchy

1. **First impression:** scene and moment explain value immediately.
2. **Behavioral truth:** scrubber, camera and evidence operate on the same timestamped state.
3. **Visual fidelity:** physically plausible scene, smooth camera, beautiful but restrained typography/layers.
4. **Production utility:** Studio behaves like a professional timeline editor, not a KPI dashboard.
5. **Resilience:** mobile, loading, missing-data, reduced-motion, low-power and offline/degraded states are designed.

A dazzling effect that weakens #2 or #5 should not ship.

## Component source study map

| Product surface | Technique to study | Primary engineering reference | Adaptation requirement |
|---|---|---|---|
| Spatial experience | 3D objects, camera rails, real-time scene updates | [Three.js](https://threejs.org/docs/), [R3F](https://r3f.docs.pmnd.rs/) | Data-driven time sampler and camera target, not fake geometry |
| Cinematic camera path | Authored easing, spline keyframes, user override | [GSAP](https://gsap.com/docs/v3/) and [Codrops](https://tympanus.net/codrops/) articles with code | Camera transitions preserve playhead, do not change source coordinates |
| Landing transition | Particle field → recognizably real stadium scene | [React Bits](https://www.reactbits.dev/) | Must lead into actual replay; respect reduced motion |
| Moment-gallery hover | Subtle depth, collectible-card tilt and preview | [Cult UI](https://www.cult-ui.com/docs/components) | Preview real manifest, keyboard-selectable and touch usable |
| Studio controls | Scrubbable timeline, dock, preview and inspector | [Cult UI Dock](https://www.cult-ui.com/docs/components/dock) and production editor precedents | Support real edit operations and revision conflicts |
| High-quality playback | Responsive image/video/canvas transitions | [Skiper UI](https://skiper-ui.com/components) | Asset loading/error/retry; test license and mobile |
| Crossfade and spatial overlays | Shader and post-processing techniques | [Codrops](https://tympanus.net/codrops/) and Three.js examples | Avoid untrusted shader execution; maintain source fidelity |

**For each adopted effect:** record source URL, license, measured bundle/GPU cost, accessibility plan, and exact reason it improves the user task. No blind copy/paste of screenshots or inaccessible premium assets.

## Design build artifact for every major screen

A PR containing **Explore**, **Studio**, **Moment Gallery**, or **Published Viewer** must include:
- Target hierarchy sketch and active/inactive/error states.
- Source-linked screenshots or code examples (not only a moodboard).
- Implemented screenshots at 1440×900, 1024×768, 390×844.
- A short real interaction recording, including touch/keyboard equivalence.
- FPS/frame time and asset load measurements on a named device.
- Known visual discrepancies and remediation.

## Screenshot review questions

Does the viewer's eye land on the moment, not the controls? Are players selectable at all camera angles? Can the user locate time, selection and proof without scrolling? Are overlays readable against grass and dark stadium backgrounds? Can analysts see numbers with units and source statuses? Do mobile controls remain accessible without sacrificing the 3D scene? Can a keyboard user do everything meaningful?

## Design invariants

- **Color isn't evidence.** Use label + dashed/dotted/solid strokes to identify provenance.
- **Camera isn't truth.** It changes viewpoint only.
- **One active selection.** Object and playhead persist across lenses.
- **No generic sidebar sprawl.** Evidence is an opt-in drawer; Studio uses an editor-style track layout.
- **Animation is interruptible.** Scrubbing or changing cameras should never fight stale GSAP timelines.
- **Reduce cost before removing utility.** Simplify shaders, crowds and shadows before removing evidence functionality.

## Acceptance rubric

Rate every shipped major UI surface 1–5 on comprehension, functional truth, cinematic quality, visual consistency, motion quality, accessibility, responsive behavior, performance and edge-state completeness. A gorgeous 5/5 screenshot with nonfunctional controls is **not eligible** for approval.

**Related:** [Design system](03-design-system.md) · [3D engine](08-3d-engine.md) · [Coding-agent policy](../AGENTS.md).