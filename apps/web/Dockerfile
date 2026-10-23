# KYN-14 — the Container App image for the live slice: the Next.js server
# (public API + SSE) which, with the Azure env contract present, also runs
# the Event Hubs ingestion worker + Web PubSub fan-out in-process
# (instrumentation.ts → azure-runtime.ts).
#
# Build + push (runbook stage 0 — requires a registry you can auth to):
#   docker build -f apps/web/Dockerfile -t <registry>/kyneloom-web:dev .
#   docker push <registry>/kyneloom-web:dev
#
# STATUS (KYN-14): authored for the deploy runbook; NOT built in this
# session (no registry authorization on this host).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/match-core/package.json packages/match-core/
COPY packages/scene-renderer/package.json packages/scene-renderer/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @kyneloom/web build

FROM node:22-alpine AS run
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
# One authoritative live projection per stream generation — single process.
EXPOSE 3000
CMD ["pnpm", "--filter", "@kyneloom/web", "start"]
