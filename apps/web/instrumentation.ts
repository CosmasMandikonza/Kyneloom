/**
 * KYN-14 — the Next.js server-start hook. In a deployed Azure Container
 * App (infra/azure), the full adapter env contract is present and the ONE
 * service process starts the Event Hubs ingestion worker + Web PubSub
 * fan-out in-process (see src/lib/live/azure-runtime.ts): durable-archive
 * replay first, then a fresh external session. Locally the env contract is
 * absent and nothing changes: the local SSE demo path only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { maybeStartAzureLiveWorker } = await import('./src/lib/live/azure-runtime');
  const result = await maybeStartAzureLiveWorker(process.env);
  console.log(`[live] azure runtime: ${result.detail}`);
}
