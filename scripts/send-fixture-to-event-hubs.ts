/**
 * KYN-14 — the documented synthetic fixture load command. Streams the
 * COMMITTED fixture (synthetic-derby-01) into the deployed Event Hub in
 * source-time order through the same `StreamEnvelope` wire contract the
 * worker consumes, with the producer-side partition key `matchId`.
 *
 * Usage (runbook stage 3; connection string from Key Vault, never a file):
 *   KYN_EVENTHUBS_SENDER_CONNECTION_STRING="Endpoint=sb://…;SharedAccessKey=…" \
 *   KYN_EVENTHUBS_NAMESPACE=kyneloom-dev-eh-xxx \
 *   KYN_EVENTHUB_NAME=kyneloom-live \
 *   KYN_LIVE_MATCH_ID=synthetic-derby-01 \
 *   pnpm live:fixture:send            # real-time at 1x
 *   SEND_SPEED=4 pnpm live:fixture:send
 *
 * STATUS (KYN-14): contract-true against the official producer SDK and
 * type-checked; NOT executed in this session (no deployed Event Hub).
 */
import { readFileSync } from 'node:fs';
import type { MatchEvent, TrackingSample } from '@kyneloom/contracts';
import { envelopeIdFor, STREAM_CONTRACT_VERSION, type StreamEnvelope } from '@kyneloom/match-core';

interface SendOptions {
  readonly namespace: string;
  readonly hubName: string;
  readonly matchId: string;
  readonly connectionString: string;
  readonly speed: 1 | 2 | 4;
}

function loadFixture(): { events: MatchEvent[]; tracking: TrackingSample[] } {
  const dir = 'tests/fixtures/generated/synthetic-derby-01';
  const events = JSON.parse(readFileSync(`${dir}/events.json`, 'utf-8')) as MatchEvent[];
  const lines = readFileSync(`${dir}/tracking.jsonl`, 'utf-8').split('\n');
  const tracking = lines
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TrackingSample);
  return { events, tracking };
}

async function sendAll(options: SendOptions): Promise<{ sent: number }> {
  const { EventHubProducerClient } = await import('@azure/event-hubs');
  const producer = new EventHubProducerClient(options.connectionString, options.hubName);
  const { events, tracking } = loadFixture();
  const envelopes: StreamEnvelope[] = [];
  for (const event of events) {
    envelopes.push({
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: envelopeIdFor(
        options.matchId,
        'event',
        `${event.eventId}@r${String(event.sourceRevision)}`,
      ),
      matchId: options.matchId,
      kind: 'event',
      event,
      emittedAt: Date.now(),
      traceId: `trc-fixture-${event.eventId}`,
    });
  }
  envelopes.sort((a, b) => {
    const ta = a.kind === 'event' ? a.event!.occurredAtMs : a.tracking!.sampleTimeMs;
    const tb = b.kind === 'event' ? b.event!.occurredAtMs : b.tracking!.sampleTimeMs;
    return ta - tb;
  });
  let i = 0;
  for (const sample of tracking) {
    i += 1;
    envelopes.push({
      contractVersion: STREAM_CONTRACT_VERSION,
      envelopeId: envelopeIdFor(options.matchId, 'tracking', `${String(i)}`),
      matchId: options.matchId,
      kind: 'tracking',
      tracking: sample,
      emittedAt: Date.now(),
      traceId: `trc-fixture-t${String(i)}`,
    });
  }
  envelopes.sort((a, b) => {
    const ta = a.kind === 'event' ? a.event!.occurredAtMs : a.tracking!.sampleTimeMs;
    const tb = b.kind === 'event' ? b.event!.occurredAtMs : b.tracking!.sampleTimeMs;
    return ta - tb;
  });

  let sent = 0;
  const batchOf = 200;
  for (let start = 0; start < envelopes.length; start += batchOf) {
    const batch = await producer.createBatch({
      // Partition key = matchId keeps per-match ordering (docs/09).
      partitionKey: options.matchId,
    });
    for (const envelope of envelopes.slice(start, start + batchOf)) {
      if (!batch.tryAdd({ body: envelope })) throw new Error('batch too small for envelope');
    }
    await producer.sendBatch(batch);
    sent += batch.count;
    await new Promise((resolve) => setTimeout(resolve, 1000 / options.speed));
  }
  await producer.close();
  return { sent };
}

async function main(): Promise<void> {
  const speedArg = Number(process.env.SEND_SPEED ?? '4');
  const speed: 1 | 2 | 4 = speedArg === 1 || speedArg === 2 ? speedArg : 4;
  const namespace = process.env.KYN_EVENTHUBS_NAMESPACE;
  const hubName = process.env.KYN_EVENTHUB_NAME;
  const matchId = process.env.KYN_LIVE_MATCH_ID ?? 'synthetic-derby-01';
  const connectionString = process.env.KYN_EVENTHUBS_SENDER_CONNECTION_STRING;
  if (namespace === undefined || hubName === undefined || connectionString === undefined) {
    throw new Error(
      'required env: KYN_EVENTHUBS_SENDER_CONNECTION_STRING (from Key Vault), KYN_EVENTHUBS_NAMESPACE, KYN_EVENTHUB_NAME',
    );
  }
  const result = await sendAll({ namespace, hubName, matchId, connectionString, speed });
  console.log(
    `sent ${String(result.sent)} envelopes to ${namespace}/${hubName} (match ${matchId})`,
  );
}

void main();
