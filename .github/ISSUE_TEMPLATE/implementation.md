---
name: "Engineering vertical slice"
about: "Implement a real, testable Kyneloom user outcome with evidence, not scaffolding or mockups"
title: "[KYN-XX] "
labels: ""
assignees: ""
---

## User outcome
What real user action becomes possible when this issue is finished?

## Track, dependencies and canonical contracts
- Priority / founder lane:
- Depends on:
- Read [AGENTS.md](../../AGENTS.md), [docs/18-execution-board.md](../../docs/18-execution-board.md), and linked domain docs:
- Source of truth for time, coordinates, evidence and scene version:

## Implementation prompt for Suzie Code / Codex
> Build [specific user behavior] from [actual input] into [typed output]. Inspect existing code and upstream library source first. Work in a separate branch, implement actual running behavior, execute tests, and attach real UI video/screenshots or trace evidence. Do not invent match facts, unlicensed assets or credentials.

## Detailed functional scope
- [ ] Real input and output connected.
- [ ] Loading / no-data / error / permission states implemented.
- [ ] Failure and correction behavior specified.
- [ ] Fallback and accessibility addressed.

## Acceptance criteria
- [ ] Test with exact fixture/seed:
- [ ] Typecheck/lint/build:
- [ ] Adversarial/negative test:
- [ ] If UI, screenshot and interaction QA 1440×900 / 1024×768 / 390×844, touch/keyboard/reduced-motion:
- [ ] If cloud, actual trace/cost/latency (or transparently marked unavailable):
- [ ] If agent, evaluate against a simpler baseline when feasible:

## Review evidence
PR link, actual commands/logs, browser screenshot/video, known limitations, changes to contracts/docs, applicable third-party source/license.

## Out of scope
What is explicitly deferred to another issue?
