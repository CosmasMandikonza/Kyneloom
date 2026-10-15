import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exampleMomentManifest,
  parseMatchEvent,
  parseMatchState,
  parseMomentManifest,
  parseTrackingSample,
} from '@kyneloom/contracts';

/**
 * KYN-02 corpus: the versioned on-disk fixtures under
 * tests/fixtures/contracts are validated through the public contracts API.
 * The valid manifest must stay identical to the exported shared example, so
 * docs, corpus and consumer tests cannot drift apart.
 */

const corpusRoot = path.resolve(import.meta.dirname, 'fixtures', 'contracts');

type ParserName =
  'parseMomentManifest' | 'parseMatchEvent' | 'parseTrackingSample' | 'parseMatchState';

const PARSERS = {
  parseMomentManifest,
  parseMatchEvent,
  parseTrackingSample,
  parseMatchState,
} as const;

interface CorpusResult {
  ok: boolean;
  data?: unknown;
  errors?: { fieldPath: string; code: string; message: string }[];
}

function parseWith(name: ParserName, input: unknown): CorpusResult {
  const result = PARSERS[name](input);
  return result.ok ? { ok: true, data: result.data } : { ok: false, errors: [...result.errors] };
}

interface Expectation {
  parser: ParserName;
  expectFieldPath?: string;
  expectCode?: string;
  expectMessageContains?: string;
}

function loadJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(corpusRoot, relative), 'utf-8')) as unknown;
}

describe('valid corpus', () => {
  it('parses the on-disk golden manifest and keeps it identical to the shared example', () => {
    const parsed = parseWith('parseMomentManifest', loadJson('valid/moment-manifest.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.data) return;
    expect(parsed.data).toEqual(exampleMomentManifest());
  });

  it('parses every valid match event, including the correction chain', () => {
    const events = loadJson('valid/match-events.json') as unknown[];
    expect(events).toHaveLength(3);
    for (const [index, event] of events.entries()) {
      const result = parseWith('parseMatchEvent', event);
      expect(result.ok, `event ${index} must parse`).toBe(true);
    }
  });

  it('parses ball, player and reconstructed tracking samples', () => {
    const samples = loadJson('valid/tracking-samples.json') as unknown[];
    expect(samples).toHaveLength(3);
    for (const [index, sample] of samples.entries()) {
      const result = parseWith('parseTrackingSample', sample);
      expect(result.ok, `sample ${index} must parse`).toBe(true);
    }
  });

  it('parses the coherent match-state projection', () => {
    expect(parseWith('parseMatchState', loadJson('valid/match-state.json')).ok).toBe(true);
  });

  it('parses the event-only projection with an explicitly unavailable ball (review fix 1)', () => {
    const result = parseWith('parseMatchState', loadJson('valid/match-state-event-only.json'));
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) return;
    expect((result.data as { ball: { position: { kind: string } } }).ball.position.kind).toBe(
      'unavailable',
    );
  });
});

describe('adversarial corpus (each file must fail with its documented expectation)', () => {
  const expectations = JSON.parse(
    readFileSync(path.join(corpusRoot, 'invalid', 'expectations.json'), 'utf-8'),
  ) as Record<string, Expectation>;

  const files = readdirSync(path.join(corpusRoot, 'invalid')).filter(
    (f) => f.endsWith('.json') && f !== 'expectations.json',
  );

  it('covers every expectation and vice versa', () => {
    expect(new Set(files)).toEqual(new Set(Object.keys(expectations)));
    expect(files.length).toBeGreaterThanOrEqual(16);
  });

  for (const file of files) {
    it(`rejects ${file}`, () => {
      const expectation = expectations[file];
      if (!expectation) throw new Error(`no expectation recorded for ${file}`);
      const result = parseWith(expectation.parser, loadJson(path.join('invalid', file)));
      expect(result.ok, `${file} must be rejected`).toBe(false);
      if (result.ok || !result.errors) return;

      if (expectation.expectFieldPath) {
        expect(
          result.errors.some((e) => e.fieldPath === expectation.expectFieldPath),
          `expected an error at ${expectation.expectFieldPath}; got ${JSON.stringify(result.errors.map((e) => [e.fieldPath, e.code]))}`,
        ).toBe(true);
      }
      if (expectation.expectCode) {
        expect(
          result.errors.some((e) => e.code === expectation.expectCode),
          `expected code ${expectation.expectCode}; got ${JSON.stringify(result.errors.map((e) => e.code))}`,
        ).toBe(true);
      }
      if (expectation.expectMessageContains) {
        expect(
          result.errors.some((e) => e.message.includes(expectation.expectMessageContains!)),
          `expected a message containing "${expectation.expectMessageContains}"`,
        ).toBe(true);
      }
    });
  }
});
