import { describe, expect, it } from 'vitest';
import {
  approvalContentPayload,
  canonicalJsonStringify,
  manifestInputFingerprint,
  parseMomentManifest,
  parseReleaseRecord,
  type MomentManifest,
} from './moment-manifest';
import { exampleMomentManifest } from './example-manifest';

/**
 * The golden manifest is the shared example exported from contracts
 * (`exampleMomentManifest`) — the same artifact the fixture generator and
 * renderer tests consume, so docs, corpus and code cannot drift apart.
 * Camera/overlay times are offsets from moment start; timeRangeMs is
 * absolute match-relative time.
 */
const validManifest = exampleMomentManifest();

describe('parseMomentManifest — the golden fixture', () => {
  it('parses the adapted docs/06 example', () => {
    const result = parseMomentManifest(validManifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.timeRangeMs).toEqual([4717000, 4731000]);
    expect(result.data.scene.cameraTracks[0]?.keyframes).toHaveLength(2);
  });

  it('snapshots the parsed golden manifest (stable contract surface)', () => {
    const result = parseMomentManifest(validManifest);
    if (!result.ok) throw new Error('golden manifest must parse');
    expect(canonicalJsonStringify(result.data)).toMatchSnapshot();
  });
});

describe('parseMomentManifest — scene rejections', () => {
  it('rejects nonmonotonic camera keyframes with a precise path', () => {
    const bad = structuredClone(validManifest);
    bad.scene.cameraTracks[0]!.keyframes[1]!.tMs = 0;
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[1].tMs'),
    ).toBe(true);
  });

  it('rejects keyframes outside the moment window (offset-vs-absolute guard)', () => {
    const bad = structuredClone(validManifest);
    bad.scene.cameraTracks[0]!.keyframes[1]!.tMs = 4731000; // absolute time used as offset
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Both guards fire: track-local interval and moment-window containment.
    const windowError = result.errors.find(
      (e) =>
        e.fieldPath === 'scene.cameraTracks[0].keyframes[1].tMs' &&
        e.message.includes('moment window'),
    );
    expect(windowError).toBeDefined();
  });

  it('rejects camera tracks ending beyond the window', () => {
    const bad = structuredClone(validManifest);
    bad.scene.cameraTracks[0]!.endMs = 15000;
    expect(parseMomentManifest(bad).ok).toBe(false);
  });

  it('rejects out-of-range FOV and cameras below the pitch plane', () => {
    const narrow = structuredClone(validManifest);
    narrow.scene.cameraTracks[0]!.keyframes[0]!.fovDeg = 5;
    expect(parseMomentManifest(narrow).ok).toBe(false);

    const underground = structuredClone(validManifest);
    underground.scene.cameraTracks[0]!.keyframes[0]!.position = [0, 10, -2];
    const result = parseMomentManifest(underground);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[0].position[2]'),
    ).toBe(true);
  });

  it('rejects NaN coordinates in keyframes', () => {
    const bad = structuredClone(validManifest);
    bad.scene.cameraTracks[0]!.keyframes[0]!.target = [Number.NaN, 0, 0];
    expect(parseMomentManifest(bad).ok).toBe(false);
  });

  it('rejects unknown coordinate systems', () => {
    const bad = structuredClone(validManifest);
    (bad.scene as { coordinateSystem: string }).coordinateSystem = 'three-y-up-v0';
    expect(parseMomentManifest(bad).ok).toBe(false);
  });

  it('rejects arbitrary scripts and unknown rendering commands (strict policy)', () => {
    for (const injection of [
      { script: 'fetch("https://evil.example")' },
      { onEnter: 'renderer.destroy()' },
      { command: 'eval' },
    ]) {
      const bad = { ...structuredClone(validManifest), ...injection } as unknown;
      const result = parseMomentManifest(bad);
      expect(result.ok, JSON.stringify(injection)).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.code === 'unrecognized_key')).toBe(true);
      }
    }
  });

  it('rejects overlays outside the window and data overlays without evidence', () => {
    const late = structuredClone(validManifest);
    late.scene.overlays[0]!.endMs = 99999;
    expect(parseMomentManifest(late).ok).toBe(false);

    const bare = structuredClone(validManifest);
    bare.scene.overlays[0]!.evidenceIds = [];
    const result = parseMomentManifest(bare);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'scene.overlays[0].evidenceIds')).toBe(true);

    const editorialCaption = structuredClone(validManifest);
    editorialCaption.scene.overlays[0]!.kind = 'caption';
    editorialCaption.scene.overlays[0]!.evidenceIds = [];
    expect(parseMomentManifest(editorialCaption).ok).toBe(true);
  });
});

describe('parseMomentManifest — claims and evidence', () => {
  it('rejects evidence references that are not declared in the manifest', () => {
    const bad = structuredClone(validManifest);
    bad.claims[0]!.evidenceIds = ['evidence-missing'];
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'claims[0].evidenceIds[0]')).toBe(true);
  });

  it('rejects overlay evidence references that are not declared', () => {
    const bad = structuredClone(validManifest);
    bad.scene.overlays[0]!.evidenceIds = ['ghost'];
    expect(parseMomentManifest(bad).ok).toBe(false);
  });

  it('rejects observed/calculated claims without evidence', () => {
    const bad = structuredClone(validManifest);
    bad.claims[0]!.evidenceIds = [];
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'claims[0].evidenceIds')).toBe(true);
  });

  it('rejects hypotheses without an inference disclosure, but never upgrades them to observed', () => {
    const bad = structuredClone(validManifest);
    delete bad.claims[1]!.inferenceDisclosure;
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.fieldPath === 'claims[1].inferenceDisclosure')).toBe(true);
  });

  it('rejects duplicate lens entries and empty lens lists', () => {
    const dup = structuredClone(validManifest);
    dup.lenses = ['fan', 'fan'];
    expect(parseMomentManifest(dup).ok).toBe(false);

    const none = structuredClone(validManifest);
    none.lenses = [];
    expect(parseMomentManifest(none).ok).toBe(false);
  });
});

describe('parseMomentManifest — time window and versions', () => {
  it('rejects reversed, tiny and oversized moment windows (negative durations)', () => {
    const reversed = structuredClone(validManifest);
    reversed.timeRangeMs = [4731000, 4717000];
    expect(parseMomentManifest(reversed).ok).toBe(false);

    const tiny = structuredClone(validManifest);
    tiny.timeRangeMs = [4717000, 4717100];
    const result = parseMomentManifest(tiny);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.fieldPath === 'timeRangeMs')).toBe(true);
    }

    const huge = structuredClone(validManifest);
    huge.timeRangeMs = [0, 600_000];
    expect(parseMomentManifest(huge).ok).toBe(false);
  });

  it('rejects negative absolute moment start times', () => {
    const bad = structuredClone(validManifest);
    bad.timeRangeMs = [-1000, 13000];
    expect(parseMomentManifest(bad).ok).toBe(false);
  });

  it('rejects unsupported manifest versions and placeholder hashes', () => {
    const versioned = structuredClone(validManifest);
    versioned.schemaVersion = '0.2.0';
    const result = parseMomentManifest(versioned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('unsupported_version');

    const placeholder = structuredClone(validManifest);
    placeholder.input.sourceHash = 'sha256:PLACEHOLDER_NOT_A_REAL_HASH';
    expect(parseMomentManifest(placeholder).ok).toBe(false);
  });
});

describe('parseMomentManifest — approval semantics', () => {
  const serverApproval = {
    approvedBy: 'producer-ada',
    approvedAt: '2026-10-14T10:00:00Z',
    manifestHash: 'sha256:c348d8c4d7739f6eaee701c5b641a635c5d7b829bbbf5579f67de5d6fd20c269',
    policyVersion: 'demo-synthetic-policy-v1',
  };

  it('rejects a client-editable status that carries an approval', () => {
    const bad = structuredClone(validManifest) as { status: string; approval: unknown };
    bad.approval = serverApproval; // status stays draft
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) => e.fieldPath === 'approval' && e.message.includes('client-editable'),
      ),
    ).toBe(true);
  });

  it('accepts an approved manifest carrying the server-issued record', () => {
    const good = structuredClone(validManifest) as { status: string; approval: unknown };
    good.status = 'approved';
    good.approval = serverApproval;
    const result = parseMomentManifest(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const approved: MomentManifest = result.data;
    expect(approved.approval?.manifestHash).toContain('sha256:');
  });

  it('rejects authorized statuses without an approval record', () => {
    for (const status of ['approved', 'published', 'revoked'] as const) {
      const bad = structuredClone(validManifest);
      bad.status = status;
      const result = parseMomentManifest(bad);
      expect(result.ok, status).toBe(false);
    }
  });
});

describe('parseReleaseRecord', () => {
  const validRelease = {
    releaseId: 'rel-0001',
    manifestId: 'mom-synthetic-78m',
    manifestHash: 'sha256:c348d8c4d7739f6eaee701c5b641a635c5d7b829bbbf5579f67de5d6fd20c269',
    approvedBy: 'producer-ada',
    approvedAt: '2026-10-14T10:00:00Z',
    policyVersion: 'demo-synthetic-policy-v1',
    status: 'published',
  };

  it('accepts a published release and a fully documented revocation', () => {
    expect(parseReleaseRecord(validRelease).ok).toBe(true);
    expect(
      parseReleaseRecord({
        ...validRelease,
        status: 'revoked',
        revokedAt: '2026-10-15T08:00:00Z',
        revocationReason: 'rights-holder request',
      }).ok,
    ).toBe(true);
  });

  it('rejects silent revocations and revocation fields on live releases', () => {
    const silent = { ...validRelease, status: 'revoked' };
    expect(parseReleaseRecord(silent).ok).toBe(false);

    const liveWithTombstone = { ...validRelease, revokedAt: '2026-10-15T08:00:00Z' };
    expect(parseReleaseRecord(liveWithTombstone).ok).toBe(false);
  });

  it('rejects non-hash manifest hashes', () => {
    expect(parseReleaseRecord({ ...validRelease, manifestHash: 'not-a-hash' }).ok).toBe(false);
  });
});

describe('manifestInputFingerprint (revalidation trigger)', () => {
  it('is deterministic across array order (fingerprint sorts before canonicalizing)', () => {
    const base = parseManifestOf(validManifest);
    const shuffled = structuredClone(validManifest);
    shuffled.input.sourceEventIds = [...shuffled.input.sourceEventIds].reverse();
    expect(manifestInputFingerprint(base)).toBe(
      manifestInputFingerprint(parseManifestOf(shuffled)),
    );
  });

  it('changes when a verified source revision changes (forcing revalidation)', () => {
    const base = parseManifestOf(validManifest);
    const bumped = structuredClone(validManifest);
    bumped.input.reducerRevision = 12;
    const bumpedParsed = parseManifestOf(bumped);
    expect(manifestInputFingerprint(base)).not.toBe(manifestInputFingerprint(bumpedParsed));

    const extraEvent = structuredClone(validManifest);
    extraEvent.input.sourceEventIds = ['evt-0042', 'evt-0043'];
    expect(manifestInputFingerprint(base)).not.toBe(
      manifestInputFingerprint(parseManifestOf(extraEvent)),
    );
  });
});

function parseManifestOf(input: unknown): MomentManifest {
  const result = parseMomentManifest(input);
  if (!result.ok) throw new Error(`fixture must parse: ${JSON.stringify(result.errors)}`);
  return result.data;
}

describe('camera track-local keyframe bounds (review fix 3)', () => {
  it('rejects keyframes outside the track interval even when inside the moment window', () => {
    const bad = structuredClone(validManifest);
    const track = bad.scene.cameraTracks[0]!;
    track.startMs = 6000;
    track.endMs = 8000;
    // keyframes remain at 0 and 14000 — inside the 14 s moment, outside the track.
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const first = result.errors.find(
      (e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[0].tMs',
    );
    const last = result.errors.find(
      (e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[1].tMs',
    );
    expect(first?.message).toContain("track's interval");
    expect(last?.message).toContain("track's interval");
  });

  it('rejects a keyframe before the track start and accepts keys spanning exactly the interval', () => {
    const early = structuredClone(validManifest);
    early.scene.cameraTracks[0]!.startMs = 2000; // keyframe at 0 is now early
    expect(parseMomentManifest(early).ok).toBe(false);

    const exact = structuredClone(validManifest);
    exact.scene.cameraTracks[0]!.startMs = 0;
    exact.scene.cameraTracks[0]!.endMs = 14000;
    exact.scene.cameraTracks[0]!.keyframes = [
      { tMs: 2000, position: [0, 46, 48], target: [0, 0, 0], fovDeg: 48 },
      { tMs: 8000, position: [6, 40, 36], target: [10, 0, 1], fovDeg: 45 },
    ];
    expect(parseMomentManifest(exact).ok).toBe(true);
  });
});

describe('collection id uniqueness (review fix 4)', () => {
  it('rejects duplicate camera track ids at the repetition position', () => {
    const bad = structuredClone(validManifest);
    bad.scene.cameraTracks.push(structuredClone(bad.scene.cameraTracks[0]!));
    const result = parseMomentManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some(
        (e) =>
          e.fieldPath === 'scene.cameraTracks[1].id' &&
          e.message.includes('duplicate camera track id'),
      ),
    ).toBe(true);
  });

  it('rejects duplicate overlay, claim and evidence ids with collection-specific errors', () => {
    const overlayDup = structuredClone(validManifest);
    overlayDup.scene.overlays.push(structuredClone(overlayDup.scene.overlays[0]!));
    let result = parseMomentManifest(overlayDup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.fieldPath === 'scene.overlays[1].id')).toBe(true);
    }

    const claimDup = structuredClone(validManifest);
    claimDup.claims.push(structuredClone(claimDup.claims[0]!)); // third entry duplicates claims[0]
    result = parseMomentManifest(claimDup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.fieldPath === 'claims[2].id')).toBe(true);
    }

    const evidenceDup = structuredClone(validManifest);
    evidenceDup.evidence.push(structuredClone(evidenceDup.evidence[0]!));
    result = parseMomentManifest(evidenceDup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.fieldPath === 'evidence[1].id')).toBe(true);
    }
  });

  it('the golden manifest keeps unique ids everywhere (positive control)', () => {
    const result = parseManifestOf(validManifest);
    expect(new Set(result.scene.cameraTracks.map((t) => t.id)).size).toBe(1);
    expect(new Set(result.evidence.map((e) => e.id)).size).toBe(result.evidence.length);
  });
});

describe('camera coordinate magnitude bounds (review fix 5)', () => {
  it('rejects finite-but-huge camera positions and targets', () => {
    const farPosition = structuredClone(validManifest);
    farPosition.scene.cameraTracks[0]!.keyframes[0]!.position = [90_000, 46, 48];
    const result = parseMomentManifest(farPosition);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.fieldPath === 'scene.cameraTracks[0].keyframes[0].position[0]'),
    ).toBe(true);

    const farTarget = structuredClone(validManifest);
    farTarget.scene.cameraTracks[0]!.keyframes[0]!.target = [0, -120_000, 0];
    expect(parseMomentManifest(farTarget).ok).toBe(false);
  });

  it('accepts the golden camera geometry (positive control)', () => {
    expect(parseMomentManifest(validManifest).ok).toBe(true);
  });
});

describe('approvalContentPayload (review fix 6)', () => {
  const serverApproval = {
    approvedBy: 'producer-ada',
    approvedAt: '2026-10-14T10:00:00Z',
    manifestHash: 'sha256:c348d8c4d7739f6eaee701c5b641a635c5d7b829bbbf5579f67de5d6fd20c269',
    policyVersion: 'demo-synthetic-policy-v1',
  };

  it('excludes mutable workflow status and the approval record itself', () => {
    const payload = approvalContentPayload(parseManifestOf(validManifest));
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('approval');
    expect(payload).toHaveProperty('schemaVersion', '0.1.0');
    expect(payload).toHaveProperty('manifestId', 'mom-synthetic-78m');
    expect(payload).toHaveProperty('rightsPolicyRef');
  });

  it('is invariant under status transitions and approval attachment', () => {
    const draft = parseManifestOf(validManifest);

    const approved = structuredClone(validManifest) as { status: string; approval: unknown };
    approved.status = 'approved';
    approved.approval = serverApproval;
    const approvedParsed = parseManifestOf(approved);

    const published = structuredClone(approved) as { status: string };
    published.status = 'published';

    const a = canonicalJsonStringify(approvalContentPayload(draft));
    const b = canonicalJsonStringify(approvalContentPayload(approvedParsed));
    const c = canonicalJsonStringify(approvalContentPayload(parseManifestOf(published)));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('changes when any content-bearing field changes (one claim edit)', () => {
    const base = canonicalJsonStringify(approvalContentPayload(parseManifestOf(validManifest)));
    const edited = structuredClone(validManifest);
    edited.claims[0]!.text = 'The defender separation increased sharply during the run.';
    expect(canonicalJsonStringify(approvalContentPayload(parseManifestOf(edited)))).not.toBe(base);
  });
});
