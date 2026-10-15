import { describe, expect, it } from 'vitest';
import { locateEvent } from './event-geometry';
import { createPitchDimensions } from './pitch';

const baseEvent = {
  schemaVersion: '1.0',
  eventId: 'evt-0042',
  providerId: 'kyneloom-simulator',
  tenantId: 'demo-org',
  matchId: 'synthetic-derby-01',
  sourceRevision: 1,
  kind: 'pass_completed',
  occurredAtMs: 4722000,
  ingestedAt: '2026-10-12T14:30:05Z',
  sequence: 414,
  actorId: 'home-08',
  teamId: 'home',
  position: { xM: 21.4, yM: -13.8 },
  provenance: { origin: 'synthetic_ground_truth', confidence: 1 },
  correctionOf: null,
};

describe('locateEvent (backend contract consumption)', () => {
  const pitch = createPitchDimensions();

  it('validates and locates an in-bounds event using canonical coordinates', () => {
    const result = locateEvent(baseEvent, pitch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.kind).toBe('pass_completed');
    expect(result.withinPitch).toBe(true);
  });

  it('flags events positioned outside the pitch', () => {
    const result = locateEvent({ ...baseEvent, position: { xM: 80, yM: 0 } }, pitch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.withinPitch).toBe(false);
  });

  it('honors the out-of-line margin for legitimate stepping', () => {
    const result = locateEvent({ ...baseEvent, position: { xM: 53, yM: 0 } }, pitch, {
      marginM: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.withinPitch).toBe(true);
  });

  it('reports absence explicitly for events without a position', () => {
    const result = locateEvent({ ...baseEvent, position: undefined, kind: 'substitution' }, pitch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toBeNull();
    expect(result.withinPitch).toBeNull();
  });

  it('surfaces contract validation errors with field paths, never repairs them', () => {
    const result = locateEvent({ ...baseEvent, occurredAtMs: Number.NaN }, pitch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'occurredAtMs')).toBe(true);

    const unknown = locateEvent({ ...baseEvent, secretScript: 'rm -rf' }, pitch);
    expect(unknown.ok).toBe(false);
  });
});
