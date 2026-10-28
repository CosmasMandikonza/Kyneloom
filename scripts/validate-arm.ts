/**
 * KYN-14 — compiled-ARM semantic validation. Bicep compilation alone does
 * NOT prove deployability: this script asserts the generated ARM for the
 * properties that actually matter (verified role GUIDs, monitoring SKU,
 * cross-module references, probe/scale/env contract, least-privilege
 * rules). Run after `bicep build` (local: .tools/bicep.exe; CI: pinned
 * install) via `pnpm infra:validate`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const BICEP =
  process.env.KYN_BICEP ?? (process.platform === 'win32' ? '.tools/bicep.exe' : 'bicep');

const OUT = '.arm-validate';
mkdirSync(OUT, { recursive: true });

function build(name: string, file: string): unknown {
  execFileSync(BICEP, ['build', file, '--outfile', path.join(OUT, `${name}.json`)], {
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(path.join(OUT, `${name}.json`), 'utf-8'));
}

interface ArmResource {
  type: string;
  name?: string | string[];
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

const failures: string[] = [];
function check(ok: boolean, label: string): void {
  if (ok) {
    console.log(`  ok: ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

console.log('main.json — semantic assertions');
const main = build('main', 'infra/azure/main.bicep') as { resources: ArmResource[] };
const mainText = JSON.stringify(main);

// Verified built-in role GUIDs (Microsoft Learn, checked 2026-10-23).
const ROLE_GUIDS = {
  blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  eventHubsReceiver: 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde',
  keyVaultSecretsUser: '4633458b-17eb-44cb-8b45-409dd3ee2f9e',
};
for (const [label, guid] of Object.entries(ROLE_GUIDS)) {
  const count = mainText.split(guid).length - 1;
  check(count >= 1, `role assignment references verified ${label} GUID`);
}
check(
  !mainText.includes('displayName'),
  'no role looked up by display name (unstable identifiers)',
);

// The container-app module receives the monitor workspace customerId
// DIRECTLY (never derived by splitting a resource id).
const caDeployment = main.resources.find(
  (r) =>
    r.type === 'Microsoft.Resources/deployments' &&
    Array.isArray(r.name) === false &&
    String(r.name).includes('live-container-app'),
) as ArmResource | undefined;
if (caDeployment === undefined) {
  check(
    false,
    'live-container-app deployment present (deployApp default false — build with -p? not needed: module emitted only if true; validating template structure instead)',
  );
} else {
  const caParams = JSON.stringify((caDeployment.properties as { parameters?: unknown }).parameters);
  check(caParams.includes('workspaceCustomerId'), 'CA receives workspace customerId directly');
  check(!caParams.includes('split('), 'no resource-id string surgery for the workspace reference');
}

console.log('monitor.json — SKU');
const monitor = build('monitor', 'infra/azure/modules/monitor.bicep') as {
  resources: ArmResource[];
};
const workspace = monitor.resources.find((r) => r.type.includes('workspaces')) as
  ArmResource | undefined;
check(
  (workspace?.properties as { sku?: { name?: string } } | undefined)?.sku?.name === 'PerGB2018',
  'Log Analytics SKU is PerGB2018 (pay-as-you-go)',
);

console.log('container-apps.json — runtime contract');
const ca = build('ca', 'infra/azure/modules/container-apps.bicep') as {
  resources: ArmResource[];
};
const app = ca.resources.find((r) => r.type.includes('containerApps')) as ArmResource | undefined;
const appProps = app?.properties as
  | {
      configuration?: {
        activeRevisionsMode?: string;
        secrets?: unknown[];
        ingress?: { transport?: string };
      };
      template?: {
        scale?: { minReplicas?: number; maxReplicas?: number };
        containers?: {
          env?: { name: string; value?: string; secretRef?: string }[];
          probes?: { type: string; httpGet?: { path?: string } }[];
        }[];
      };
    }
  | undefined;
const container = appProps?.template?.containers?.[0];
check(
  appProps?.configuration?.activeRevisionsMode === 'Multiple',
  'manual revision handoff (deactivate old owner before waiting for replacement readiness)',
);
const envNames = new Set(container?.env?.map((e) => e.name));
check(
  container?.env?.find((e) => e.name === 'NEXT_MANUAL_SIG_HANDLE')?.value === '1',
  'cloud SIGTERM exit waits for worker drain (Next automatic signal cleanup disabled)',
);
for (const required of [
  'KYN_EVENTHUBS_NAMESPACE',
  'KYN_EVENTHUB_NAME',
  'KYN_EVENTHUBS_CONSUMER_GROUP',
  'KYN_CHECKPOINT_CONTAINER_URL',
  'KYN_ARCHIVE_CONTAINER_URL',
  'KYN_WEBPUBSUB_HUB',
  'KYN_WEBPUBSUB_CONNECTION_STRING',
  'KYN_AZURE_CLIENT_ID',
  'KYN_LIVE_MATCH_ID',
]) {
  check(envNames.has(required), `app env includes ${required}`);
}
check(
  container?.env?.find((e) => e.name === 'KYN_WEBPUBSUB_CONNECTION_STRING')?.secretRef ===
    'webpubsub-connection-string',
  'Web PubSub secret is Key-Vault secretRef (never a literal)',
);
check(
  container?.probes?.find((p) => p.type === 'Readiness')?.httpGet?.path === '/api/live/ready',
  'readiness probe targets /api/live/ready (worker readiness, not liveness)',
);
check(
  container?.probes?.find((p) => p.type === 'Liveness')?.httpGet?.path === '/api/live/status',
  'liveness probe targets /api/live/status',
);
check(
  appProps?.template?.scale?.minReplicas === 1 && appProps?.template?.scale?.maxReplicas === 1,
  'min=max=1 replica (ONE authoritative projection per generation)',
);

console.log('event-hubs.json — least privilege');
const eh = build('eh', 'infra/azure/modules/event-hubs.bicep') as { resources: ArmResource[] };
const senderRule = eh.resources.find((r) => r.type.endsWith('authorizationRules')) as
  ArmResource | undefined;
check(
  JSON.stringify((senderRule?.properties as { rights?: string[] })?.rights) === '["Send"]',
  'fixture-sender rule is Send-only',
);
// Child resource names compile to format expressions ending '/reducer'.
const groups = eh.resources.filter((r) => r.type.endsWith('consumergroups'));
check(
  groups.some((g) => JSON.stringify(g.name).includes("'reducer'")),
  'explicit reducer consumer group',
);

console.log('storage.json — private archive');
const st = build('st', 'infra/azure/modules/storage.bicep') as { resources: ArmResource[] };
const account = st.resources.find((r) => r.type.includes('storageAccounts')) as
  ArmResource | undefined;
check(
  (account?.properties as { allowBlobPublicAccess?: boolean })?.allowBlobPublicAccess === false,
  'storage account denies public blob access',
);

rmSync(OUT, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\nARM VALIDATION FAILED (${String(failures.length)}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nARM VALIDATION PASSED');
