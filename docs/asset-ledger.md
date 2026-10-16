# Asset rights ledger — KYN-06 / KYN-30

Every runtime asset shipped in the public client bundle is listed here with
verified provenance. "Verified" means the license text was retrieved from the
source at acquisition time and the downloaded bytes were hash-checked; it does
not mean downstream terms cannot change — re-verify before any future re-export.

| Asset | Source & author | License | Commercial use | Redistribution of the shipped file | Verification |
| --- | --- | --- | --- | --- | --- |
| `apps/web/public/models/footballer.glb` (808,348 B) — rigged humanoid base mesh, 65-bone skeleton, 4 clips (Idle / Walk / Jog_Fwd / Sprint_Loop) | Derived from "Universal Animation Library" (UAL1_Standard) by [Quaternius](https://quaternius.itch.io/), downloaded from `quaternius.itch.io/universal-animation-library` (upload id 17958403) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — no attribution required, expressly permitted for commercial use and any redistribution/modification | Yes (CC0) | Yes (CC0) | Source pack sha256 `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`; subset extraction is reproducible via `node scripts/build-player-asset.mjs <UAL1_Standard.glb>` |
| `Kyneloom_Kick` animation clip (pass/shot leg swing) | Authored in-repo (`apps/web/src/app/explore/scene/footballers.tsx`, quaternion keyframe tracks composed onto the rig's rest pose) | Repository code (project license) | Yes | Yes (project source) | Unit tests assert the clip's construction; deterministic pure function of `playheadMs` |
| Stadium, pitch, goals, floodlights, ad boards, ball texture | Procedurally generated in-repo (`apps/web/src/app/explore/scene/stadium.tsx`, `ball.tsx` — canvas-drawn textures, IFAB-measured geometry) | Repository code (project license) | Yes | Yes (project source) | Geometry tests in `stadium` unit suite; no external bytes |
| Fonts (Geist / Geist Mono) | Vercel, served via `next/font` self-hosting | SIL OFL 1.1 | Yes | Yes (self-hosted per OFL) | Bundled by Next.js font pipeline |
| three.js, @react-three/fiber, @react-three/drei runtime code | npm packages (MIT each) | MIT | Yes | Yes (MIT) | `pnpm-lock.yaml` pins exact versions |

Notable decisions and constraints:

- **No Mixamo, marketplace, or scanned assets ship in the bundle.** The Quaternius
  UAL pack is CC0, which permits redistribution inside a public client without
  attribution; we still credit the author here and in the Explore page's
  metadata note.
- The shipped GLB is a **subset** of the source pack (4 of 43 clips; finger
  animation channels and texture coordinates dropped to keep the download at
  ~0.8 MB). The extraction is a committed, re-runnable Node script — no binary
  hand-editing.
- Team identities (Northbridge Athletic mint, Vale Rovers coral), player
  numbers and goalkeeper kits are fictional; no real club marks, league
  logos, player likenesses, or broadcast footage are used anywhere in the
  scene. Kit color is a per-team material tint applied at runtime — the
  underlying mesh is the shared CC0 base. The Explore page's metadata panel
  carries a visible "character base rig: Quaternius, CC0" credit.
- 10 Hz tracking cannot capture real limb biomechanics; all local skeletal
  animation is labeled reconstructed presentation (docs/08, docs/19).

**Related:** [19 — Realistic character pipeline](19-realistic-character-pipeline.md) ·
[10 — Security and rights](10-security-and-rights.md)
