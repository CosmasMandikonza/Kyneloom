# 16 — Visual execution: reference → implementation → screenshot QA

> **Scope:** actionable frontend engineering procedure. The linked libraries are *references to inspect*, not installed dependencies.
>
> **Required companion:** [17 — Source-verified frontend implementation](17-source-verified-frontend.md), including real inspected component paths, actual code mechanics, licenses, app surface mapping and explicit rejection rules.

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

## Implemented visual QA procedure (KYN-05, extended for KYN-06)

The committed script `scripts/visual-qa.ts` (`pnpm qa:visual`) builds the web app, boots the production server, and drives Playwright Chromium through the four routes (`/`, `/explore`, `/studio`, `/m/mom-synthetic-78m`) at **1440×900, 1280×800, 1024×768, 390×844 and 375×812**, plus `prefers-reduced-motion` captures at 1440×900 and 390×844 for `/` and `/explore`.

Per capture it asserts: no horizontal overflow, zero console errors, and route-specific behavior (landing CTA + real fixture facts, studio disabled publication controls + reducer-derived event markers, viewer truthful unpublished state). On `/explore` the KYN-06 pass additionally asserts, against the live 3D scene: the R3F canvas actually initializes (headless Chromium WebGL2), the scene QA hook reports exactly **22 players / 0 missing**, camera radios are enabled and switching cameras leaves the world snapshot **byte-identical**, seek → seek-back returns the identical pose, the Reset control lands on the checkpoint with the **golden ball truth** (21.241, −2.172, 0.11, exact), keyboard arrows move the playhead and Space toggles play, the transport never overlaps the stage (mobile included), the 2D fallback mounts on the same timeline via the view toggle, and the perf probe reports sane frame statistics after 4 s of real playback. A nav-flow pass walks landing → explore → studio via real clicks.

Two committed recorders produce the video evidence. `pnpm qa:record:live` (scripts/record-replay-live.ts) records the **continuous, real-time 30 fps screencast** `qa/video/living-replay-screencast.mp4` (+ `.webm` twin): headed GPU Chromium in a fixed window region captured with ffmpeg gdigrab — checkpoint freeze → decoy run + pass (broadcast) → scrub back → player-follow camera → shot + goal at 4728300 → paused aftermath, self-checked for adjacent-frame motion. In-browser screencast APIs on this host write blank constant-luminance WebM (verified with ffmpeg signalstats), so the screen-level capture is the honest real-time route. Its deterministic companion `pnpm qa:record` (scripts/record-replay.ts) produces `qa/video/living-replay-800x600.webm`, a **4 fps frame-step compilation** (explicitly not a continuous recording): the paused playhead is seeked in exact 250 ms increments, each rendered frame screenshotted, assembled at true match speed — every frame sits at a known reproducible playhead. `pnpm qa:visual`'s live-playback checks (camera independence, seek determinism, rendered-mesh pose, camera convergence, perf probe) complement both with the interactive behavior.

Artifacts land in `qa/screenshots/*.png`, `qa/video/*.webm` and `qa/report.json` (machine-written, excluded from Prettier). The run exits non-zero on any failure. The operator then **inspects the screenshots and video personally** and iterates the design — during KYN-05 this loop caught and fixed: a misspelled eyebrow (`SYNTHIC` → `SYNTHETIC`), imperceptible pitch-line art, a cramped scroll cue, a light scrollbar against the dark theme, indistinguishable camera/lens groups, a hidden tools rail in Studio, and faint timeline gridlines. During KYN-06 it caught: a 932 px-tall stage that pushed the transport below the fold at 1440×900, an overhead camera that cropped two corners of the 68 m pitch, and a home kit that vanished against green turf.

Unit-level interaction coverage lives in `apps/web/src/app/explore/replay-stage.test.tsx` (jsdom + Testing Library: lens radiogroup, camera switching, play/pause/speed/step/reset transport, ms-explicit scrubber, accessible-lens 2D fallback), `apps/web/src/lib/playback.test.ts` (pure transport arithmetic) and `apps/web/src/lib/scene-data.test.ts` (server→client boundary).

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