# 14 — Competitive landscape and differentiation claims

> **As of October 2026.** A comparison of public product positioning and hackathon *idea descriptions*, not a certified exhaustive market survey.

## Important anti-novelty fallacies

**3D replay already exists.** Genius Sports/Second Spectrum offers immersive spatial sports analysis and player perspectives.

**Animated alternative worlds already exist.** Beyond Sports/Sony established nontraditional broadcast rendering.

**Video generation/workflow already exists.** WSC Sports, ScorePlay and other companies serve AI-assisted media production and distribution.

**Tactical off-ball analysis already exists.** Football analytics platforms (including Kognia) study runs, spaces and decision patterns.

Therefore “AI + 3D + football + agents” is not a defensible claim. We must demonstrate a specifically better **workflow and output primitive**.

## Feature competition map

| Reference | Publicly described strength | What Kyneloom should learn | What not to assume |
|---|---|---|---|
| [Genius Sports](https://www.geniussports.com/) | Tracking, immersive analytics, sports broadcast augmentation | Track-to-scene fidelity, performance, real analyst workflows | We can reproduce proprietary tracking fidelity from event data alone |
| [Sony Beyond Sports](https://www.beyondsports.nl/) | Alternative animated sports visualizations | Distinct modes and audience experience design | Simply rendering a virtual football match is novel |
| [WSC Sports](https://wsc-sports.com/) | Automated media content at scale | Editorial and downstream publishing integration | We need our own asset-management platform to compete |
| [ScorePlay](https://scoreplay.io/) | Sports media workflow/asset platform | Enterprise production process and rights-aware distribution | A clip library is the differentiated product |
| [Kognia](https://kognia.com/) | Football tactical analysis | Grounded geometry and specialist football reasoning | Tactical causality follows from position coordinates automatically |
| [SkillCorner Open Data](https://github.com/SkillCorner/opendata) | Tracking-format and event-data examples | Source provenance, sample flags, realistic sampling | Open sample data can be freely republished as official PL content |

**Potential gap:** producer-editable, versioned, interactive scene compilation with evidence and audience adaptation. This is a *hypothesis to test*, not proof that no competitor provides it.

## Direct hackathon concept crowding

**Updated snapshot (October 13, 2026):** the supplied gallery reports **128 results**, but the provided text exposes **126 numbered entries (1–126)**. See the [dated gallery competitive radar](20-competitive-radar-2026-10-13.md) for competitor-by-competitor overlap, methodology, uncertainty, and required changes. The older list of 84 was an earlier snapshot and is superseded. The following themes recur:

- **MatchDirector, Virtual Studio Crew, MatchMind Studio** — AI broadcast agent teams, commentary and overlays.
- **Pitch Ledger, MatchDesk, WhyLine** — audited or explainable football insights.
- **GhostPlay, Shift11, Sisyphus Engine** — tactical/off-ball/strain analysis.
- **Second Guess** — alternate-outcome/what-if simulator.
- **Audio Eyes, Sauti, Msimulizi** — accessibility and multilingual audio.
- **SignalFlow, Second Story** — story selection and attention systems.

These are *descriptions*, not independently verified completed implementations. Their existence is enough to avoid marketing “first to offer multi-agent football commentary” or “first explainable AI match lens.”

## Strategic positioning

**Primary product:** programmable, evidence-linked Playable Moment.

**Primary buyer hypothesis:** sports media rights holder or production team with licensed event/tracking data.

**First distinctive customer outcome:** transform structured match events into an authorized interactive explanation and publish it without custom 3D development for each moment.

**Hardest technical risks:** reliable positional data; honest observed-versus-inferred semantics; convincing in-browser rendering; editorial confidence and rights management.

**Hardest market risks:** customers may prefer video clips; incumbent product bundling; data licensing and integration costs; limited discoverability of interactive embeds.

## Research actions before claiming differentiation

1. Interview at least five prospective rights-holding media users about workflow, existing tools and most costly pain point.
2. User-test the playable moment versus a well-edited normal replay, blind to product brand.
3. Measure producer creation time and revision count for same 78th-minute moment.
4. Evaluate whether a sample company can integrate an interactive scene using a typed manifest/SDK without custom scene code.
5. Keep a dated competitor matrix and note functionality verified firsthand versus public marketing.

**New competitor-driven product decision:** prove **multi-output compilation from the same canonical moment**: immersive time-faithful 3D scene + transparent synchronized broadcast overlays + source-linked recap + producer-approved embeddable release. See [#31 broadcast overlay](https://github.com/CosmasMandikonza/Kyneloom/issues/31). This is more robust differentiation than relying on 3D aesthetics or evidence verification alone.

**Decision:** build and test one impressive compiler-to-viewer pipeline with a genuine broadcast output; refine differentiation using implemented evidence, not adjectives.