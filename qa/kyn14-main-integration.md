# KYN-14 main integration: historical QA provenance

This document records conflict resolution, **not a new visual QA run**. No screenshot was deleted or regenerated to resolve the merge.

The feature parent is `8710319ed373b1846bc0a3a69b94338f877cc4a3`; the incoming main parent is `6a85ca58005a3be746aefb1c660001b6670c9f23`. The merge retains main's exact committed bytes for `qa/report.json` and the 29 conflicted PNGs. [The provenance manifest](kyn14-main-integration-provenance.json) records each path, previous/selected blob IDs, and the last commit that changed each version. Both parents and all earlier evidence remain in Git history.

## Selected report: newer, explicitly partial

- Last changed in [`e123c284`](https://github.com/CosmasMandikonza/Kyneloom/commit/e123c28453c8e1f552abe48d46422ce3ac87bab2), the KYN-17 bounded Studio / delivery-freeze evidence commit.
- Reported generation time: `2026-10-26T15:13:42.415Z`; 16 capture records.
- Generator: `scripts/visual-qa.ts` (`pnpm qa:visual`). The commit message describes a run interrupted by the delivery freeze. The JSON retains its `ERR_CONNECTION_REFUSED` failure. **This is not a passing full visual matrix.**
- All 16 referenced screenshots exist, have the recorded viewport dimensions, and are byte-identical between that report commit and the incoming main parent.
- Separate main artifacts (`studio-bounded-report.json`, `kyn20-smoke-report.json`, `ask-smoke-report.json`) and their screenshot files are retained. They are distinct historical runs, not merged into this report.

## Previous feature report: retained in history

- Last changed in [`0a0d4e77`](https://github.com/CosmasMandikonza/Kyneloom/commit/0a0d4e77a502608e4e1bc2b98e4aa630f5bba188), the initial KYN-14 infrastructure commit.
- Reported generation time: `2026-10-23T17:55:23.017Z`; 38 capture records, no recorded failures.
- Generator: the earlier `scripts/visual-qa.ts` / `pnpm qa:visual`. The commit message reports a passing 38-capture run.
- There are 36 unique referenced screenshot paths. `screenshots/nav-flow-explore.png` is absent from that historical tree; the other 35 exist and have the recorded viewport dimensions. This limits the completeness of that archived evidence. Nothing is recreated to fill the gap.

Neither JSON records the exact built source SHA or screenshot hashes. Git establishes where each report was committed, and the PNG comparison establishes the retained artifact set; it cannot independently prove the precise checkout used by the original browser run. Timestamps are reported values. Neither historical report proves the correctness of this integrated tree. Fresh integration checks are recorded separately in the implementation review.
