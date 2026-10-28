import { formatMatchClockTenths } from './clock';
import type { SceneData, SceneEvent, ScenePlayer } from './scene-data';
import type { EvidenceProjection } from './evidence-data';
import type { FrameSnapshot } from '@/app/explore/scene/scene-context';
import { eventAtPlayhead } from './playback';

/**
 * KYN-11 — pure lens presentation selectors.
 *
 * Every function here derives its presentation from the SAME authoritative
 * inputs the 3D scene uses (sampled frames, source events, the verified
 * evidence projection). Nothing invents football facts: coordinates come
 * from sampled tracking, events carry their source ids, measurements carry
 * their classification, and uncertainty is disclosed in words. All
 * functions are pure and unit-tested against the committed fixture.
 */

/**
 * Pitch-zone wording is NEUTRAL and coordinate-relative (review round):
 * "attacking/defending third" is a TEAM-RELATIVE fact — attack direction is
 * stored per team and per half in the fixture (docs/05) and cannot be
 * inferred from X alone (the ball has no attacking third). X speaks only
 * for itself: +X is the right end of the pitch's own coordinate frame,
 * −X the left end. Y keeps the documented canonical orientation
 * (docs/05: +y towards the upper touchline in canonical 2D).
 */
function pitchZone(xM: number): string {
  if (xM > 34.5) return 'in the right third of the pitch';
  if (xM < -34.5) return 'in the left third of the pitch';
  return 'in the middle third of the pitch';
}

function pitchSide(yM: number): string {
  if (yM > 11) return 'nearer the upper touchline';
  if (yM < -11) return 'nearer the lower touchline';
  return 'through the central lane';
}

export interface SpatialDescription {
  /** One-sentence headline ("At 78:42.1, …"). */
  readonly summary: string;
  /** Structured detail lines, each individually source-grounded. */
  readonly details: readonly string[];
}

export interface SpatialDescriptionInput {
  readonly scene: SceneData;
  readonly frame: FrameSnapshot;
  readonly playheadMs: number;
  readonly selectedEntityId: string | null;
}

/**
 * Generate the accessible spatial description from the CURRENT sampled
 * state (never hardcoded narration): match time, ball position/zone,
 * selected player identity + position + sampled-motion note, current
 * source event, nearby tracked players (computed from sampled positions),
 * and explicit uncertainty for anything missing.
 */
export function describeSpatialState(input: SpatialDescriptionInput): SpatialDescription {
  const { scene, frame, playheadMs, selectedEntityId } = input;
  const clock = formatMatchClockTenths(playheadMs);
  const details: string[] = [];

  const activeEvent = eventAtPlayhead(playheadMs, scene.events);
  const eventText =
    activeEvent?.phase === 'active'
      ? `Source event ${activeEvent.event.eventId}: ${activeEvent.event.label} by ${activeEvent.event.actorId}.`
      : activeEvent?.phase === 'upcoming'
        ? `Next source event ${activeEvent.event.eventId}: ${activeEvent.event.label} by ${activeEvent.event.actorId} at ${formatMatchClockTenths(activeEvent.event.occurredAtMs)}.`
        : 'No source event at this instant — open play.';

  const ball = frame.positions.get(scene.ballEntityId);
  let ballText: string;
  if (ball === undefined) {
    ballText = 'The ball position is unavailable at this instant.';
  } else {
    const exact = ball.exact
      ? 'an exact tracked frame'
      : 'an interpolated position between tracked frames';
    ballText = `The ball is at ${ball.xM.toFixed(1)}, ${ball.yM.toFixed(1)} metres on the pitch (${pitchZone(ball.xM)}, ${pitchSide(ball.yM)}), ${ball.zM.toFixed(2)} metres above the ground, from ${exact}.`;
  }

  const selected =
    selectedEntityId !== null
      ? scene.players.find((p) => p.entityId === selectedEntityId)
      : undefined;
  let selectedText: string;
  if (selectedEntityId === null) {
    selectedText = 'No player is selected.';
  } else if (selected === undefined || !frame.positions.has(selectedEntityId)) {
    selectedText = `Player ${selectedEntityId} has no tracked position at this instant.`;
  } else {
    const pos = frame.positions.get(selectedEntityId)!;
    const speed = frame.velocitiesMps.get(selectedEntityId);
    const motion =
      speed === undefined
        ? 'movement not comparable at this instant'
        : speed < 0.8
          ? 'essentially stationary'
          : speed < 3.5
            ? `moving at about ${speed.toFixed(1)} metres per second`
            : `running at about ${speed.toFixed(1)} metres per second`;
    selectedText = `${scene.teams[selected.team]} number ${selected.shirtNumber} (${selectedEntityId}, ${selected.role}) is at ${pos.xM.toFixed(1)}, ${pos.yM.toFixed(1)} metres (${pitchZone(pos.xM)}, ${pitchSide(pos.yM)}), ${motion}${pos.exact ? '' : ' — position interpolated between tracked frames'}.`;
  }

  // Nearby tracked players to the SELECTED player (or ball), computed from
  // the same sampled frame — "when actually supported".
  const anchorId = selectedEntityId ?? scene.ballEntityId;
  const anchor = frame.positions.get(anchorId);
  let nearbyText: string;
  if (anchor === undefined) {
    nearbyText = 'Nearby players cannot be computed without a tracked anchor position.';
  } else {
    const teammates: string[] = [];
    const opponents: string[] = [];
    for (const player of scene.players) {
      if (player.entityId === anchorId) continue;
      const pos = frame.positions.get(player.entityId);
      if (pos === undefined) continue;
      const d = Math.hypot(pos.xM - anchor.xM, pos.yM - anchor.yM);
      if (d <= 4) {
        const entry = `${scene.teams[player.team]} #${player.shirtNumber} (${d.toFixed(1)} m)`;
        (selected !== undefined && player.team === selected.team ? teammates : opponents).push(
          entry,
        );
      }
    }
    const parts: string[] = [];
    if (teammates.length > 0) parts.push(`team-mates ${teammates.join(', ')}`);
    if (opponents.length > 0) parts.push(`opponents ${opponents.join(', ')}`);
    nearbyText =
      parts.length > 0
        ? `Within four metres of ${anchorId === scene.ballEntityId ? 'the ball' : selectedEntityId}: ${parts.join('; ')}.`
        : `No tracked player is within four metres of ${anchorId === scene.ballEntityId ? 'the ball' : selectedEntityId}.`;
  }

  const missing = frame.missingEntityIds.length;
  const uncertainty =
    missing === 0
      ? 'All 22 players and the ball are tracked at this instant.'
      : `${missing} of 23 tracked entities have no position at this instant — their whereabouts are unknown, not inferred.`;

  const summary = `At ${clock}, ${activeEvent?.phase === 'active' ? activeEvent.event.label.toLowerCase() : 'open play'}.`;
  details.push(eventText, ballText, selectedText, nearbyText, uncertainty);
  return { summary, details };
}

/** How a transcript entry was grounded. */
export type TranscriptSourceKind = 'event' | 'measurement' | 'interpretation';

export interface TranscriptEntry {
  readonly id: string;
  readonly atMs: number;
  readonly title: string;
  readonly description: string;
  readonly kind: TranscriptSourceKind;
  readonly actorId: string | null;
}

function describeEvent(event: SceneEvent, scene: SceneData): string {
  const team = scene.teams[event.teamId];
  switch (event.kind) {
    case 'pass_attempted':
      return `${team} number ${shirtOf(scene, event.actorId)} plays a pass forward from ${event.position ? `${event.position.xM.toFixed(1)}, ${event.position.yM.toFixed(1)} metres` : 'an unrecorded position'}.`;
    case 'pass_completed':
      return `The pass reaches ${team} number ${shirtOf(scene, event.actorId)} — possession is recorded at the receiver.`;
    case 'shot_attempted':
      return `${team} number ${shirtOf(scene, event.actorId)} strikes toward goal from ${event.position ? `${event.position.xM.toFixed(1)}, ${event.position.yM.toFixed(1)} metres` : 'an unrecorded position'}.`;
    case 'goal':
      return `Goal for ${team} — scored by number ${shirtOf(scene, event.actorId)}. The score changes at ${formatMatchClockTenths(event.occurredAtMs)}.`;
    default:
      return `${event.label} by ${team} number ${shirtOf(scene, event.actorId)}.`;
  }
}

function shirtOf(scene: SceneData, entityId: string): string {
  const player: ScenePlayer | undefined = scene.players.find((p) => p.entityId === entityId);
  return player === undefined ? '?' : String(player.shirtNumber);
}

/**
 * The synchronized transcript: every source event inside the window (with
 * its event id and actor), plus the verified separation measurement and its
 * explicitly-classified tactical interpretation — so a reader always knows
 * what is an event, what is a calculation and what is an interpretation.
 */
export function transcriptEntries(
  scene: SceneData,
  evidence: EvidenceProjection,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = scene.events.map((event) => ({
    id: event.eventId,
    atMs: event.occurredAtMs,
    title: `${event.label} · ${formatMatchClockTenths(event.occurredAtMs)}`,
    description: describeEvent(event, scene),
    kind: 'event',
    actorId: event.actorId,
  }));
  if (evidence.status === 'verified') {
    const e = evidence.evidence;
    entries.push({
      id: `measurement:${e.inputFingerprint}`,
      atMs: e.toMs,
      title: `Measured separation · ${formatMatchClockTenths(e.fromMs)}–${formatMatchClockTenths(e.toMs)}`,
      description: `The tracked distance between ${e.defenderId} and ${e.strikerId} grew from ${e.separationBeforeM.toFixed(3)} to ${e.separationAfterM.toFixed(3)} metres (+${e.deltaM.toFixed(3)}). Calculated by ${e.algorithmVersion} from exact source frames.`,
      kind: 'measurement',
      actorId: null,
    });
    entries.push({
      id: 'interpretation:separation',
      atMs: e.toMs,
      title: `Tactical reading · ${formatMatchClockTenths(e.toMs)}`,
      description: evidence.interpretation.text,
      kind: 'interpretation',
      actorId: null,
    });
  } else {
    // Honest absence: no verified measurement exists for this moment, so the
    // transcript SAYS so — never a fabricated description. The window and
    // reason come from the projection itself.
    entries.push({
      id: 'measurement:unavailable',
      atMs: evidence.toMs,
      title: `Measured separation · unavailable · ${formatMatchClockTenths(evidence.fromMs)}–${formatMatchClockTenths(evidence.toMs)}`,
      description: `No verified separation measurement is available for ${evidence.defenderId} and ${evidence.strikerId} in this window (${evidence.reason}). Nothing is fabricated in its place.`,
      kind: 'measurement',
      actorId: null,
    });
  }
  return entries.sort((a, b) => a.atMs - b.atMs);
}

/**
 * The fan "why this moment matters" narrative, derived from the VERIFIED
 * metric (never a second constant): plain football language, measured
 * change stated, cause kept as interpretation.
 */
export function fanExplanation(
  evidence: EvidenceProjection,
): { headline: string; body: string } | null {
  if (evidence.status !== 'verified') return null;
  const e = evidence.evidence;
  return {
    headline: 'Why this moment matters',
    body: `Between ${formatMatchClockTenths(e.fromMs)} and ${formatMatchClockTenths(e.toMs)}, the defender and the striker moved farther apart as the attack developed — the tracked gap grew by ${e.deltaM.toFixed(3)} metres (from ${e.separationBeforeM.toFixed(3)} m to ${e.separationAfterM.toFixed(3)} m). What that movement means tactically is an interpretation: the tracking measures the space, not the cause.`,
  };
}
