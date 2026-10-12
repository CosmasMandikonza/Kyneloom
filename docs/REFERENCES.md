# Sources and engineering references

> A curated list of **source materials** informing the October 2026 design. A link here is not evidence that an external feature is implemented inside Kyneloom. Check versions and licenses before coding.

## Hackathon rules

- [Microsoft / Premier League — Official Rules](https://github.com/microsoft/insidethegamehackathon/blob/main/OFFICIAL%20RULES.md) — eligibility, prize categories, judging weights, submission, synthetic footage/data and public repository requirements.
- [Microsoft Reactor — Inside the Game sessions](https://developer.microsoft.com/en-us/reactor/series/S-1709/) — organizer technical sessions and reference architecture guidance.

## Agent engineering

- [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/) — framework documentation and development options.
- [Agent Framework workflow checkpoints](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints) — checkpoint policies and runtime persistence; distinguish storage providers.
- [Durable Extension](https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension) — durable agents, handoffs, recovery and human-in-loop design.
- [Azure Durable Task + Agent Framework](https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-agents-microsoft-agent-framework) — durable workflow examples with approval ports.
- [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/ai-foundry/) — access, tools, agent management and evaluation docs (versions may evolve).

## Event and infrastructure

- [Event Hubs features and concepts](https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-features) — partitions, consumer groups, offsets.
- [Event Hubs partition behavior](https://learn.microsoft.com/en-us/azure/event-hubs/event-hubs-features#partitions) — partition-key and arrival-order constraints.
- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/overview) — managed container/runtime options.
- [Azure Web PubSub](https://learn.microsoft.com/en-us/azure/azure-web-pubsub/overview) — managed real-time client fan-out.
- [Azure Database for PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/overview) — relational operational storage.
- [Azure Blob Storage](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-introduction) — source and asset storage.
- [OpenTelemetry](https://opentelemetry.io/docs/) — traces, metrics and logging conventions.

## Spatial/data and UI

- [SkillCorner Open Data](https://github.com/SkillCorner/opendata) — 2024/25 A-League broadcast tracking examples and dynamic events, *not official hackathon fixtures*.
- [Three.js](https://threejs.org/docs/) — cameras, geometry, animation and WebGL.
- [React Three Fiber](https://r3f.docs.pmnd.rs/) — React renderer and scaling/performance guidance.
- [GSAP](https://gsap.com/docs/v3/) — animation timelines and camera choreography.
- [Codrops](https://tympanus.net/codrops/) — published interactive/WebGL engineering techniques; review original source/licensing.
- [Cult UI](https://www.cult-ui.com/docs/components) · [React Bits](https://www.reactbits.dev/) · [Skiper UI](https://skiper-ui.com/components) — component references; adapt only with source/licensing/interaction review.

## Existing ecosystem (product positioning, not endorsement)

- [Genius Sports](https://www.geniussports.com/) · [Beyond Sports](https://www.beyondsports.nl/) · [WSC Sports](https://wsc-sports.com/) · [ScorePlay](https://scoreplay.io/) · [Kognia](https://kognia.com/).

## Evidence hygiene

Before writing “first,” “real-time,” “production-grade,” “fully verified” or similar, record the tested source, date, scope, comparison and measured data. Marketing material about third-party companies is not independent engineering validation.

[← Documentation hub](README.md)