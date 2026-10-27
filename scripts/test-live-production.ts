/** Run AFTER pnpm build. Tests real next start + HTTP against production
 * instrumentation/route bundles in a child process, never a Vitest module cache.
 * The preload replaces Azure I/O only; no credentials or Azure network calls.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LiveProjectionWorker,
  STREAM_CONTRACT_VERSION,
  type LiveFrame,
  type StreamEnvelope,
} from '@kyneloom/match-core';
import type { ProductionReply } from './support/live-production-preload';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(root, 'apps/web');
const buildId = readFileSync(path.join(app, '.next/BUILD_ID'), 'utf8').trim();
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
async function until<T>(probe: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 25_000;
  do {
    const value = await probe();
    if (accept(value)) return value;
    await pause();
  } while (Date.now() < deadline);
  throw new Error('production test condition timed out');
}
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
interface Stats {
  pid: number;
  threadId: number;
  archiveStarts: number;
  consumers: number;
  checkpoints: number;
  broadcasts: number;
  leases: number;
  service: { running: boolean; sessionId: string; stateVersion: string; seq: number };
}
function batch(time: number): StreamEnvelope[] {
  return [
    {
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: `production-${time}`,
      matchId: 'synthetic-derby-01',
      kind: 'tracking',
      emittedAt: 1,
      traceId: `trc-production-${time}`,
      tracking: {
        schemaVersion: '1.0',
        matchId: 'synthetic-derby-01',
        sampleTimeMs: time,
        entityId: 'home-01',
        xM: time / 1000,
        yM: 2,
        zM: 0,
        origin: 'synthetic_ground_truth',
        confidence: 1,
        visibility: 'tracked',
        sourceFrameId: `frame-${time}`,
      },
    },
  ];
}
async function start(mode: 'cloud' | 'partial' | 'local') {
  const port = await freePort();
  const scratch = mkdtempSync(path.join(tmpdir(), 'kyn14-production-'));
  // Isolated cwd keeps diagnostics out of the workspace. The committed
  // fixture is read through a symlink; Next receives the real app directory.
  const { symlinkSync } = await import('node:fs');
  symlinkSync(path.join(root, 'tests'), path.join(scratch, 'tests'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_MANUAL_SIG_HANDLE: '1',
    TSX_TSCONFIG_PATH: path.join(app, 'tsconfig.json'),
    KYNELOOM_LIVE_CONTROL_TOKEN: 'production-test-only',
  };
  for (const key of Object.keys(env))
    if (/^(KYN_|AZURE_|IDENTITY_|MSI_|IMDS_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
  if (mode !== 'local') Object.assign(env, { KYN_EVENTHUBS_NAMESPACE: 'test' });
  if (mode === 'cloud')
    Object.assign(env, {
      KYN_EVENTHUB_NAME: 'test',
      KYN_EVENTHUBS_CONSUMER_GROUP: 'reducer',
      KYN_CHECKPOINT_CONTAINER_URL: 'https://test.blob.core.windows.net/checkpoints',
      KYN_ARCHIVE_CONTAINER_URL: 'https://test.blob.core.windows.net/archive',
      KYN_WEBPUBSUB_CONNECTION_STRING: 'unused',
      KYN_WEBPUBSUB_HUB: 'live',
      KYN_AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
    });
  const child = fork(
    path.join(app, 'node_modules/next/dist/bin/next'),
    ['start', app, '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: scratch,
      env,
      execArgv: [
        '--import',
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
        '--import',
        path.join(root, 'scripts/support/live-production-preload.ts'),
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  child.stdout?.on('data', (data) => {
    output += String(data);
  });
  child.stderr?.on('data', (data) => {
    output += String(data);
  });
  let requestId = 0;
  let exitReport: { code: number; leases: number } | undefined;
  const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on(
    'message',
    (message: ProductionReply & { event?: string; code: number; leases: number }) => {
      if (message.event === 'exit') {
        exitReport = message;
        return;
      }
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.ok) pending?.resolve(message.value);
      else pending?.reject(new Error(message.error));
    },
  );
  child.on('exit', () => {
    for (const pending of requests.values()) pending.reject(new Error(`server exited: ${output}`));
    requests.clear();
  });
  const command = <T = unknown>(command: string, body: Record<string, unknown> = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`production IPC command timed out: ${command}`));
      }, 15_000);
      requests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ id, command, ...body });
    });
  const request = (route: string, options?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...options,
      signal: options?.signal ?? AbortSignal.timeout(5000),
    });
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit;
    clearTimeout(timer);
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    await until(
      async () => {
        assert.equal(child.exitCode, null, output);
        try {
          return (await request('/api/live/status')).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
    );
    assert(output.includes('[live] azure runtime:'), output);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    child,
    request,
    command,
    cleanup,
    exit,
    get exitReport() {
      return exitReport;
    },
  };
}
async function sse(server: Awaited<ReturnType<typeof start>>) {
  const controller = new AbortController();
  const response = await server.request('/api/live/stream?speed=4', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let buffer = '';
  const frames: Record<string, unknown>[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += new TextDecoder().decode(value);
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const record = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = record.split('\n').find((line) => line.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    frames,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

console.log(`Production bundle regression, build ${buildId}`);
for (const termination of ['loss', 'signal'] as const) {
  const server = await start('cloud');
  let stream: Awaited<ReturnType<typeof sse>> | undefined;
  try {
    await until(
      () => server.command<Stats>('stats'),
      (s) => s.consumers === 1,
    );
    assert.equal((await server.request('/api/live/ready')).status, 503);
    const before = await server.command<Stats>('stats');
    assert.equal(before.pid, server.child.pid);
    assert.equal(before.threadId, 0);
    await server.command('ready');
    assert.equal((await server.request('/api/live/ready')).status, 200);
    stream = await sse(server);
    await until(
      async () => stream!.frames,
      (frames) => frames.some((f) => f.type === 'snapshot'),
    );
    const input = batch(1000);
    await server.command('receive', { batch: input });
    const reference = new LiveProjectionWorker({
      matchId: 'synthetic-derby-01',
      sessionId: before.service.sessionId,
    });
    reference.admit(input);
    const snapshot = (await (await server.request('/api/live/snapshot')).json()) as {
      frame: LiveFrame;
    };
    assert.deepEqual(snapshot.frame, reference.snapshot());
    await until(
      async () => stream!.frames,
      (frames) =>
        frames.some((f) => f.type === 'delta' && f.stateVersion === reference.currentVersion),
    );
    await Promise.all(
      Array.from({ length: 12 }, () =>
        server
          .request('/api/live/status')
          .then((r) => r.json())
          .then((r) => {
            assert.equal(r.status.sessionId, before.service.sessionId);
            assert.equal(r.status.stateVersion, reference.currentVersion);
            assert.equal(r.azureRuntime.active, true);
          }),
      ),
    );
    const repeated = await server.command<{ started: boolean }[]>('repeat-start');
    assert(repeated.every((r) => !r.started));
    assert.equal((await server.command<Stats>('stats')).archiveStarts, 1);
    assert.equal((await server.command<Stats>('stats')).consumers, 1);
    if (termination === 'loss') {
      await server.command('lose');
      await until(
        async () => (await server.request('/api/live/ready')).status,
        (status) => status === 503,
      );
      await until(
        async () => stream!.frames,
        (frames) => frames.some((f) => f.status === 'disconnected'),
      );
      assert.equal((await server.request('/api/live/snapshot')).status, 503);
      await server.command('receive', { batch: batch(1200) }); // retired callback is a no-op
      const after = await server.command<Stats>('stats');
      assert.equal(after.service.running, false);
      assert.equal(after.checkpoints, 1);
      assert.equal(after.broadcasts, 1);
      assert.equal(after.consumers, 1);
      await assert.rejects(server.command('local-start'), /local producer disabled/);
      console.log(
        'PASS: instrumentation → one process/service/session → readiness, snapshot and SSE; concurrent requests/start guard; lease loss withdraws readiness and stream, blocks stale effects/local fallback',
      );
    } else {
      await server.command('block-broadcast');
      await server.command('receive', { batch: batch(1200) });
      await until(
        () => server.command<Stats>('stats'),
        (s) => s.broadcasts === 2,
      );
      server.child.kill('SIGTERM');
      await until(
        async () => (await server.request('/api/live/ready')).status,
        (status) => status === 503,
      );
      assert.equal((await server.command<Stats>('stats')).leases, 1); // still draining issued send
      assert.equal((await server.command<Stats>('stats')).consumers, 1);
      await server.command('release-broadcast');
      assert.equal(await server.exit, 0);
      assert.deepEqual(
        server.exitReport && { code: server.exitReport.code, leases: server.exitReport.leases },
        { code: 0, leases: 0 },
      );
      console.log(
        'PASS: production SIGTERM withdraws readiness, drains an issued broadcast, releases lease then exits 0; no second worker',
      );
    }
  } finally {
    await stream?.close();
    await server.cleanup();
  }
}
for (const mode of ['partial', 'local'] as const) {
  const server = await start(mode);
  let stream: Awaited<ReturnType<typeof sse>> | undefined;
  try {
    assert.equal((await server.request('/api/live/ready')).status, 503);
    stream = await sse(server);
    if (mode === 'partial') {
      await until(
        async () => stream!.frames,
        (frames) => frames.some((f) => f.status === 'disconnected'),
      );
      assert.equal((await server.request('/api/live/ready')).status, 503);
      await assert.rejects(server.command('local-start'), /local producer disabled/);
      assert.equal((await server.command<Stats>('stats')).consumers, 0);
    } else {
      await until(
        async () => stream!.frames,
        (frames) => frames.some((f) => f.type === 'delta'),
      );
      assert.equal((await server.request('/api/live/ready')).status, 200);
      assert.equal((await server.request('/studio/compile')).status, 200);
    }
    console.log(
      `PASS: production ${mode} mode ${mode === 'partial' ? 'fails closed without fixture fallback' : 'streams the real local fixture and serves compiler'}`,
    );
  } finally {
    await stream?.close();
    await server.cleanup();
  }
}
