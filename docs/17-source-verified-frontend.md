# 17 — Source-verified frontend implementation blueprint

> **Verified reference review:** 12 October 2026. **Status:** implementation specification, **not a claim the UI is built, visually matched, or tested.**
>
> **Hard promise to contributors:** A list of attractive components is not an interface. Kyneloom must be a distinctive, cinematic **working experience**, not a textual research paper with generic cards and a miniature pitch.

## 0. Exactly what we inspected

The goal of this document is to connect *real source code and interaction mechanics* to *particular Kyneloom screens*. References have different roles: source to adapt, art-direction case study, or visual quality benchmark.

| Source / exact public implementation | What was actually found | Appropriate use | Limitation |
|---|---|---|---|
| [Cult UI Dock documentation](https://www.cult-ui.com/docs/components/dock) · [source code](https://github.com/nolly-studio/cult-ui/blob/main/apps/www/registry/default/ui/dock.tsx) | \`motion/react\`; \`useMotionValue\`, \`useSpring\`, \`useTransform\`; shared \`DockContext\`, cursor \`mouseX\`, \`DockCard\`/dividers; desktop pointer magnification | Compact edge/floating navigation for product destinations and tools | Source styles/absolute positioning are demo-specific; **do not copy layout dimensions or position blindly** |
| [React Bits Orb](https://www.reactbits.dev/backgrounds/orb) · [TS/TW source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-tailwind/Backgrounds/Orb/Orb.tsx) | OGL \`Renderer\`/\`Program\`/\`Mesh\` and GLSL vertex/fragment shader, \`iTime\`, hue/hover/rotation uniforms, render loop, pointer and resize handlers, WebGL cleanup | Landing visual / ambient interaction | Orb is **not** a 3D particle disintegration effect or real 3D pitch; hero transition requires custom code |
| [React Bits Tilted Card](https://www.reactbits.dev/components/tilted-card) · [TS/TW source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-tailwind/Components/TiltedCard/TiltedCard.tsx) | \`useMotionValue\`, \`useSpring\`, pointer-relative offset → \`rotateX/rotateY\`; perspective 800px, optional \`translateZ\` overlay; hover scale and tooltip | Playable Moment tiles in discovery | Upstream explicitly displays a mobile optimization warning by default; build accessible touch/static fallback |
| [React Bits Pixel Card](https://www.reactbits.dev/components/pixel-card) · [TS/TW source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-tailwind/Components/PixelCard/PixelCard.tsx) | Canvas pixel engine, pointer/focus/click triggers, configurable colors/spacing/origin; canvas has \`aria-hidden\` and children remain separate | Selective reveal / collectible moment hover or click | Not appropriate for grids of always-running effects; respect reduced motion and GPU/CPU budget |
| [React Bits Card Swap](https://www.reactbits.dev/components/card-swap) · [TS/TW source](https://github.com/DavidHDev/react-bits/blob/main/src/ts-tailwind/Components/CardSwap/CardSwap.tsx) | Custom RAF state and 3D card poses, drag samples, autoplay/pause options, callbacks \`onChange\`/\`onCardClick\` | Curated home/showcase story sequence, if interaction justifies complexity | Not a data table; separate from the primary match viewer |
| [Skiper UI Video Player 001](https://skiper-ui.com/v1/skiper67) | \`VideoPlayer\`, \`VideoPlayerContent\`, \`VideoPlayerControlBar\`, \`VideoPlayerTimeRange\`, \`VideoPlayerPlayButton\`, \`VideoPlayerMuteButton\`; media-chrome + Motion | Genuine video clip/showreel and broadcast media pane | Never use it to pretend an MP4 is the interactive spatial replay |
| [Codrops: Blender camera path → Three.js + GSAP](https://tympanus.net/codrops/2026/07/07/building-a-scroll-driven-3d-gallery-using-a-blender-camera-path-with-three-js-and-gsap/) · [example code](https://github.com/gaspardhedde) | Blender curve export transforms Z-up to Y-up; \`THREE.CatmullRomCurve3\`, camera path parameter \`t\`, \`gsap.quickTo\` smoothing, reuse of textures | Cinematic directed camera shots and transition choreography | The gallery's image-plane camera path is inspiration—not football physics |
| [Codrops: Ridgeline 2026](https://tympanus.net/codrops/2026/07/22/building-ridgeline-engineering-a-real-time-3d-experience-in-webflow/) | Real Blender geometry → Draco GLB; R3F, GSAP/Lenis; versioned asset delivery; scroll progress in ref/useFrame, careful transform-only animations, first-paint handling | Production-quality asset pipeline, render-loop discipline and interaction finish | Terrain example is not a reusable football renderer |
| [React Three Fiber performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance) | Shared materials/geometries, instancing, measured draw calls and device-aware render costs | Core renderer and mobile optimization | Cannot assert frame rate without measuring on actual devices |
| [Awwwards](https://www.awwwards.com/) | Visual quality/discovery gallery and case studies | Judge the level of finish, composition, motion design and coherence | Awwwards recognition does **not** mean implementation/source is public. Use primary developer breakdowns for engineering details. |

### Critical source-versus-docs mismatch to avoid

The live Cult UI Dock usage documentation shows an import containing `Card`, but the inspected [registry dock.tsx](https://github.com/nolly-studio/cult-ui/blob/main/apps/www/registry/default/ui/dock.tsx) exports `Dock`, `DockCard`, `DockCardInner`, `DockDivider`, and `useDock`—**not `Card`**. The registry implementation's `DockCardInner` also calls `parseInt(id)` for animation state. That is exactly the sort of hidden discrepancy that can make an AI-generated implementation break or look wrong.

**Required implementation fix:** pin the specific version fetched by the registry CLI; inspect the actual generated component exports before writing imports; use consistent numeric string IDs or refactor the source to use stable string IDs throughout; replace demo image tiles with our own semantic, keyboard-operable command controls. Do not paste the documentation snippet unmodified or rely on its sample absolute positioning. Run a compile and interaction check on the actual installed code.

The React Bits Tilted Card source similarly uses `setLastY` in a mouse-move handler, which can trigger React re-rendering on each pointer move. If using dozens of animated moment tiles, replace that hot state with a ref/motion value (and measure), or limit active animations. Exact visual fidelity **and** performance matter.

### Licenses matter

- Cult UI repository: [MIT](https://github.com/nolly-studio/cult-ui/blob/main/LICENSE.md); preserve notices when copying source.
- React Bits: [MIT + Commons Clause](https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md); application use is permitted under published conditions, but selling/sublicensing/redistributing **the components themselves** is restricted. Preserve notices; confirm any planned distribution in our standalone SDK.
- Skiper UI free components: published page says free commercial modification with **attribution required**; Pro examples may require a paid license. We must not install Pro-only components without rights.
- Code for third-party media samples, image thumbnails, player likenesses and background music have *separate* rights.

These are inspected source/licensing descriptions, not legal opinions.

## 1. Visual architecture: one product, not four disconnected demos

### A. Landing — **Enter the match**

**Above the fold:** near-full-screen spatial scene, not 15 feature cards. Kyneloom wordmark and restrained top navigation. A live-looking but **clearly labeled synthetic** football scene fills most of the viewport. One strong editorial statement, one major CTA: **Enter the moment**.

**Signature sequence:** ambient shader/orb motif → geometric fragments/particles draw a pitch plane → camera glides onto the actual R3F match scene → ready to interact.

**Implemented (KYN-09, 2026-10-17):** the landing signature sequence is real. Upstream inspected at commit `482ab1cd3f567467a8dc9f49683bcefe54223e2c` (2026-10-11) — the CURRENT Orb is a raw-WebGL2 fullscreen fragment shader (the OGL dependency of older versions was removed upstream; this doc's earlier OGL description is superseded by the pinned source). License: MIT + Commons Clause v1.0 (Copyright 2026 David Haz) — application use permitted, components themselves not redistributable; notice preserved in `apps/web/src/app/landing/orb-shader.ts`. Adaptation: the GLSL3 fragment shader is ported verbatim (minus the `#version`/`precision` lines Three injects) into a `ShaderMaterial` fullscreen triangle inside the landing's single R3F canvas; the upstream per-frame JS driver is re-expressed as the pure, unit-tested `OrbDriver` class; one documented uniform was added (`uCenter` — screen anchor so the orb composes right-of-center on desktop and upper on mobile). The fragment morph, pitch reveal, FSM (`lib/landing-transition.ts`) and the `/explore?enter=orb` handoff are original Kyneloom engineering on the canonical fixture geometry.

**Implementation reality:** React Bits Orb is an OGL fullscreen shader. It does not morph itself into R3F objects. A faithful transition needs a **single state-machine driver**:
\`idle → orb_intro → fragment_transition → pitch_reveal → interactable\`.
At transition, capture or fade the orb canvas, draw dedicated particle/fragment layer (Three.js particles, ShaderMaterial or instanced geometry), morph controlled particles/opacity/scale toward known pitch landmarks, and hand camera ownership to \`LivingReplayCanvas\`. Trigger scene-load readiness before crossfading. Respect skip and reduced-motion.

**No fake “live AI”:** captions must say “Synthetic match scenario” until real match data is licensed.

### B. Moment discovery — **Collectible interactions**

**Implemented (KYN-10, 2026-10-17): the Playable Moment gallery is real at `/moments`.** Upstream inspected at commit `310fc737fadcaa149a4e06fb088fc95332dc8bfb` (2026-10-17) — the current React Bits `TiltedCard` is no longer the older `setLastY`-in-mousemove version this doc previously warned about; upstream has itself moved to a settle-aware spring integrator (`step()` at fixed 1/240 s sub-steps), a `wake()` pattern whose rAF loop stops when every spring settles, and direct DOM style/custom-property writes. License: MIT + Commons Clause v1.0 (Copyright 2026 David Haz) — application use permitted, the components themselves not redistributable; attribution preserved in `apps/web/src/app/moments/tilt.ts`. Adaptation (mechanics, not code): the spring integrator, wake/settle loop gating, pointer-relative clamped rotation, lift/scale state and pointer-following glare custom properties are re-expressed in a purpose-built, unit-tested controller (`createTiltController`, `stepSpring`) — no flip/tooltip/gyroscope/intro machinery, no window-global listeners (card-local only), reduced motion disables every spatial write (not just shrinks them), and a live registry (`tiltRegistry.activeLoops()`) proves zero sustained rAF after the pointer leaves. **Evaluated and rejected:** `PixelCard` at the same commit (a 678-line per-card canvas pixel-dissolve engine — a second canvas per card, decorative pixels over honest scene imagery, contrary to restrained source-quality encoding) and `CardSwap` (a stacked-deck interaction that hides 10 of 12 chapters). The catalog is **not** a MomentManifest: `buildMomentCatalog` derives 1 featured + 12 chapter selections deterministically from the accepted golden fixture (fail-closed validation: full 23-entity exact-frame coverage per focus, distinct ids/timestamps, real event references only, and a metadata-vs-tracking integrity gate), and `/explore?moment=<catalogId>` resolves the id SERVER-SIDE into the scene's initial playhead — unknown/malformed ids never reach the scene (honest notice + default checkpoint). Card imagery comes exclusively from the offline preview pipeline (`pnpm moments:previews`, `apps/web/public/moment-previews/manifest.json`): real captures of the live renderer paused at each chapter's validated timestamp with a deliberate camera (floating chrome display:none'd — scene pixels untouched), plus one continuous compositor-capture motion preview for the featured chapter (pauses offscreen/hidden-document/reduced-motion). No WebGL on the gallery route; no hover dependency on touch (hooks always visible on coarse pointers). **Review round 2 hardening (2026-10-18):** previews are additionally BOUND to the authoritative truth before display — `bindPreviewBook` (in `previews.ts`) rejects any manifest whose match id, seed, generator version or content hashes disagree with the current fixture (stale ⇒ the whole book is withheld) and any record whose catalogId, exact focus timestamp or camera disagrees with the catalog entry it would be displayed against (mismatch/duplicate/unknown ⇒ that card's honest unavailable state; navigation unaffected); filenames are validated as bare pipeline-named basings before any filesystem use (traversal never reaches `path.join`). Catalog construction failures are converted at each route boundary by `buildMomentCatalogSafe` — technical diagnostics go to the server log, `/moments` renders its authored unavailable state, `/explore` keeps the canonical default replay and treats any selection as unknown; an absent source score timeline withholds the scoreLine fact rather than fabricating 0-0. The featured copy separates the measured separation delta and event order from the tactical causation, which is labeled as an amber INTERPRETATION disclosure matching the Evidence X-Ray hypothesis semantics.

### C. Explore — **Living Replay is 65–85% of viewport**

**Desktop scene hierarchy** (target, refine from actual screenshot review):
- Full-bleed WebGL scene (no bordered analytics card).
- Floating match/time label at top left; camera/lens status at top right.
- One compact floating tool dock at bottom/edge (camera, orbit, play, X-Ray, lens, Studio if authorized).
- Minimal playhead/time bar near bottom, draggable/scrubbable.
- Evidence appears *anchored to in-scene selected objects* + optional collapsible inspector. It must not permanently occupy a third of the viewport.
- Dark atmosphere with crisp turf, subtle volumetric depth, correct football geometry, animated trajectory ribbons tied to samples.

**Cult UI Dock adaptation:**
- Use documented \`Dock\`, \`DockCard\`, \`DockDivider\` and \`motion/react\`.
- Replace demo gradient cards with accessible labeled controls and real action callbacks.
- Use CSS positioning based on safe-area and viewport, not upstream \`left-3/4\` etc.
- Hover magnification only for pointer-capable devices; provide explicit active/focus states and large touch targets.
- **Command semantics come from shared player state**, not a dock's own animation state. Lens switch preserves playhead and selection.

**Real renderer:** R3F \`Canvas\` behind positioned DOM controls. Match state is sampled by \`playheadMs\`, not regenerated when changing lens/camera. \`CameraRig\`, \`PlayerInstances\`, \`PitchEnvironment\`, \`TacticalOverlays\`, \`SelectionLayer\`, \`EvidenceMarkers\` subscribe to their specific state slices.

### D. Evidence X-Ray — **Truth is spatial**

Select a defender → opponent distance appears as a world-anchored segment with value/units; selecting its annotation reveals source frame IDs, algorithm, provenance and uncertainty.

**Visual encoding:**
- Source-observed or true synthetic: solid mint line + source label.
- Interpolated: dotted + "interpolated" label.
- Hypothesis: dashed amber + “Interpretation” label.
- Invalid/unsupported: not rendered as verified; show rejection details in Studio.

Lens changes only verbosity and overlays. Never alter the underlying geometry or measurements to fit narrative.

### E. Studio — **A creative production application**

Model after professional timeline editors, not corporate dashboards:
- **Center:** large live interactive preview of the selected moment.
- **Bottom:** actual scrubbable multi-track timeline (camera shots, events, overlay timing, captions/audio).
- **Left (compact):** layers/assets/scenes drawer, collapsible.
- **Right (contextual):** property inspector, claim verification, audience variants, revision/approval status.
- **Top:** project breadcrumb, sync status, save/revision, Preview, Publish.
- **Agents panel:** optional tracing/debug drawer, not the main product.

AI tools should create/edit a **typed shot plan** that is visible as native timeline objects. User modifications persist to a versioned draft. Support undo/redo, editing conflicts, permissions and real publish review.

Skiper video components suit embedded real footage *within* the production workflow. They do not replace the WebGL viewer.

### F. Published player / SDK — **No dashboard shell**

Focused full-canvas interactive scene with minimal controls, attribution/evidence, light-weight embed and privacy/rights gates. Works at different iframe dimensions; fallback media or 2D viewer if 3D unavailable.

## Production character realism: do not stop at the coordinate prototype

The scene's final visual actors must be **rigged football humans** with shared animation clips and coherent uniforms, not circles/capsules in a tilted field. Use the inspected [Mixamo rigging pipeline](https://helpx.adobe.com/creative-cloud/help/mixamo-rigging-animation.html), [Blender GLB animation exporter](https://docs.blender.org/manual/en/3.6/addons/import_export/scene_gltf2.html), [Three.js SkeletonUtils](https://threejs.org/docs/pages/module-SkeletonUtils.html), [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html), and [glTF Transform optimization](https://gltf-transform.dev/). Every player's root follows shared positional source state; skeleton poses are *reconstructed* from selected licensed animation clips. A development circle marker is acceptable **only in dev/tactical fallback**. The entire pipeline, license gate, pose/replay tests, asset quality and visual acceptance are specified in **[Realistic player pipeline](19-realistic-character-pipeline.md)**.

## 2. Technically correct core implementation boundaries

\`\`\`text
apps/web/
  app/(marketing)/page.tsx
  app/(product)/moments/[id]/page.tsx
  app/(product)/studio/[id]/page.tsx
  components/landing/OrbPitchTransition.tsx
  components/discovery/MomentGallery.tsx
  components/discovery/MomentCard.tsx
  components/explore/LivingReplayCanvas.tsx
  components/explore/ReplayToolbar.tsx
  components/explore/EvidenceInspector.tsx
  components/studio/StudioTimeline.tsx
  components/studio/SceneInspector.tsx

packages/scene-renderer/
  core/sampleMatchState.ts
  core/coordinateTransform.ts
  core/normalizeCamera.ts
  camera/CameraRig.tsx
  environment/PitchEnvironment.tsx
  actors/PlayerInstances.tsx
  overlays/EvidenceOverlay.tsx
  input/SceneSelection.tsx
  quality/SceneQualityManager.ts

packages/contracts/
  match-event.schema.ts
  moment-manifest.schema.ts
\`\`\`

**This is a proposed layout; these paths do not yet exist.** Avoid implementing a second match-truth model inside the 3D frontend.

### Correct time sampler design (reference TypeScript)

\`\`\`ts
type PositionSample = {
  timeMs: number;
  xM: number;
  yM: number;
  zM: number;
  origin: "source_observed" | "synthetic_ground_truth";
};

type RenderPose = {
  position: [number, number, number];
  provenance: "exact_sample" | "interpolated" | "unavailable";
};

const MAX_INTERPOLATION_GAP_MS = 300; // proposal; tune to source sampling rate

export function samplePosition(
  before: PositionSample | null,
  after: PositionSample | null,
  playheadMs: number
): RenderPose {
  if (!before || !after) {
    return { position: [0, 0, 0], provenance: "unavailable" };
  }

  const dt = after.timeMs - before.timeMs;
  if (
    !Number.isFinite(dt) ||
    dt < 0 ||
    playheadMs < before.timeMs ||
    playheadMs > after.timeMs ||
    dt > MAX_INTERPOLATION_GAP_MS
  ) {
    return { position: [0, 0, 0], provenance: "unavailable" };
  }

  if (dt === 0) {
    return {
      position: [before.xM, before.yM, before.zM],
      provenance: "exact_sample"
    };
  }

  const t = (playheadMs - before.timeMs) / dt;
  const lerp = (a: number, b: number) => a + (b - a) * t;

  return {
    position: [
      lerp(before.xM, after.xM),
      lerp(before.yM, after.yM),
      lerp(before.zM, after.zM)
    ],
    provenance: t === 0 || t === 1 ? "exact_sample" : "interpolated"
  };
}
\`\`\`

**Important:** return \`unavailable\` as an explicit state; the surrounding render layer must **hide/fade/fallback**, not draw the sentinel \`[0,0,0]\` as a real position. This is a reference function, not compiled/tested application code. Position samples are already normalized and time-sorted by a validated upstream source.

### Render-loop discipline

- The authoritative \`playheadMs\` is held in a low-churn store; UI mirrors it at bounded intervals.
- R3F \`useFrame\` reads the playhead and samples actors, updating refs/instance matrices *without causing a React rerender per frame*.
- One canonical coordinate transform: source \`(x, y, z)\` pitch meters → Three.js \`(x, z, -y)\` world with Y-up.
- Scene uses physically valid sample windows; no camera transition should change player pose.
- Do not use GSAP simultaneously with spring controllers to write the same camera transform; **one camera driver at a time**.
- Camera paths: GSAP \`quickTo\`/springs for controlled camera target, optional Blender-authored \`CatmullRomCurve3\` for director shots. World state and camera state are independent.
- App canvas uses adaptive DPR, instancing, compressed glTF and a 2D fallback; performance metrics from actual browser devices.

### Suggested source-based API usage

**React Bits Orb, as a self-contained *marketing-only* client component:**

\`\`\`tsx
// After installing/updating the exact upstream component under its license:
import Orb from "@/components/react-bits/Orb";

// Contain as a client-only background; do not confuse this with pitch 3D.
<div className="absolute inset-0 pointer-events-none" aria-hidden="true">
  <Orb hue={145} hoverIntensity={0.12} rotateOnHover={true} />
</div>
\`\`\`

On an interactive landing page, wrapping the orb with \`pointer-events-none\` disables its pointer hover behavior. **If interactive cursor response is desired, use a pointer-enabled visual layer that doesn't intercept CTA events** (pointer events arranged explicitly), rather than copy this decorative sample verbatim. Also, production SSR and WebGL rendering must be isolated in client components.

**Real moment tile interaction built over the spring principle**: use \`TiltedCard\` for presentational hover only, but a real \`button\`/\`Link\` with title and timestamp must remain keyboard/touch operable. The source implementation is a \`figure\`, not a semantic navigational button. Ensure \`showMobileWarning={false}\` and supply a fully tested mobile fallback.

## 3. The Orb → Stadium transition: don't overpromise

This feature **does not exist as a drop-in effect**.

Recommended actual pipeline:

\`\`\`mermaid
stateDiagram-v2
  [*] --> INTRO
  INTRO --> FRAGMENT: "Enter the moment"
  INTRO --> READY: reduced motion / skip
  FRAGMENT --> PITCH_REVEAL: scene assets ready
  PITCH_REVEAL --> READY: hand camera to replay controller
  FRAGMENT --> FALLBACK: WebGL failure / timeout
  PITCH_REVEAL --> FALLBACK: render failure
  FALLBACK --> READY: 2D view
\`\`\`

**Build as one visual experiment before implementing marketing.**
- Orb's OGL canvas and R3F pitch are two rendering contexts; consider scene crossfade using an opaque cover and separate particle plane; avoid assuming you can transfer OGL shader state directly into Three.js.
- Build the fragment particles on known geometry positions (pitch corners, midfield line, player seed positions); don't imply a real football event exists behind the decorative orb.
- Reveal the already-initialized Three.js scene only after geometry and controls are ready.
- Reduced-motion path moves directly to a static pitch and CTA.
- If two simultaneous WebGL contexts cause GPU pressure, capture a still or dispose of Orb before full match renderer is active.

## 4. Visual consistency and acceptance matrix

| Surface | Mandatory visual proof | Mandatory functional proof |
|---|---|---|
| Landing | Fullscreen desktop, mobile crop, first-load, reduced motion | Orb sequence does not block CTA and fails gracefully |
| Discovery | Real cards with meaningful preview, focus and mobile fallback | Activates the *correct moment*, real ID, no ghost click |
| Explore | Overhead, player-follow, free camera; no generic dashboard in view | Scrub time, select player, switch lens, correct geometry |
| Evidence | In-scene source marker, annotation, expanded provenance | Metric matches deterministic service; hypotheses distinguishable |
| Studio | Preview / multi-track edit layout; dense but clean controls | Change shot, undo, validate, handle stale revision |
| Published player | Unbranded/brand-light responsive embed | Authorized version loads; revocation and fallback work |

**Viewport matrix**: desktop 1440×900, laptop 1280×800, tablet 1024×768, phone 390×844 and 375×812.

**Device matrix**: capable desktop GPU, integrated GPU laptop, midrange mobile, reduced-motion + keyboard-only.

**Review sequence for every major UI PR**:
1. Open *actual* source docs and commit-pinned source link for chosen component; record dependency/license.
2. Compare reference behavior frame-by-frame (hover, focus, click, drag, loading, empty).
3. Implement actual functional behavior connected to \`MomentManifest\`/match state.
4. Run screenshot automation (Playwright recommended) and examine actual images visually.
5. Fix clipping, visual hierarchy, dead controls, mobile behavior and GPU performance; repeat.
6. Record screenshots/video and benchmark data in PR. **Never claim a visual match based only on code.**

## 5. Explicit rejection criteria

Reject PR/UI generation when:
- It defaults to a left-nav admin dashboard, multiple KPI cards, generic data tables or large paragraphs for fan entry.
- “3D” means SVG/skewed divs, prerecorded movie, image spin, or orbiting a static pitch texture.
- The hero is an unrelated orbiting ball disconnected from Enter Moment.
- Replaced cards/screens aren't interactive or linked to real moment IDs.
- UI silently contradicts source provenance or changes match state across lenses.
- A loading animation or effect is present but the actual browser screenshots were never checked.
- Every page looks like a different component library with a mismatched color system.
- An agent adds 10 new dependencies without measuring their value.
- A desktop-only hover interaction is the sole way to discover or open a moment.
- The UI shows a fake streaming status, test results, real-data label, or model trace.

## 6. Source-quality accountability record

For each visual component adapted into the product, attach this table to the PR:

| Field | Record |
|---|---|
| Product screen and user task | … |
| Upstream live preview URL | … |
| Upstream **exact source file URL and commit SHA** | … |
| Package/API and dependency versions | … |
| Licensing and attribution obligations | … |
| Original animation behavior | … |
| Changes for Kyneloom (typed inputs, styling, permissions) | … |
| Desktop/mobile/reduced-motion screenshots | … |
| Actual tests and measured GPU/CPU costs | … |
| Deviations from reference + rationale | … |

**Until those artifacts exist, implementation quality is not verified.**

---

### Source review conclusion

It is **technically feasible** to build the desired visual language with real React/R3F/GSAP/OGL components and authored 3D assets. The exact end result is **not guaranteed** by these references or the current docs; it must be implemented and visually inspected repeatedly. The source reviewed here narrows the uncertainty and provides specific implementable behaviors and constraints rather than style adjectives.

**Related:** [Design system](03-design-system.md) · [3D engine](08-3d-engine.md) · [Visual QA](16-visual-reference-and-qa.md) · [Agent policy](../AGENTS.md).