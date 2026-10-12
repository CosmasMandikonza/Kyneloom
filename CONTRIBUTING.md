# Contributing to Kyneloom

Kyneloom is at the **architecture and product foundation** stage. Read [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md) before proposing code or designs.

## Contribution workflow

1. Link a change to the user outcome and milestone in [the roadmap](docs/12-delivery-roadmap.md).
2. Read the owning schema/architecture spec and relevant ADR.
3. Propose the smallest end-to-end vertical slice, including fallback and negative tests.
4. Make changes in a reviewable branch or PR. Record schema changes, migrations and security impact.
5. Include actual test output, screenshots for visible interactions, and source/licensing attribution.
6. Update documentation and status only when functionality is demonstrated.

## Pull request description template

```markdown
## User outcome
What can a real user do differently?

## Scope
Changed contracts, components and infrastructure.

## Evidence
- Executed tests:
- Screenshots / viewport sizes:
- Traces / replay fixtures:
- Known limitations:

## Security, rights and data truth
Relevant controls and negative cases.

## Review checklist
- [ ] Input/output contracts reviewed
- [ ] Failure/permission states tested
- [ ] Source-derived vs inferred data labeled
- [ ] Changes verified on mobile + desktop when UI-related
- [ ] Docs updated with honest implementation status
```

## Licensing

The repository currently has **no LICENSE file**. Do not assume source or assets are open-licensed for redistribution. Contributors must verify ownership and licenses for third-party components and sports media. Final licensing is an owner decision, not a default automatically added for the hackathon.

## Security reporting

Do not open public issues containing active credentials, protected footage or private customer data. Contact a repository maintainer privately through an established channel.
