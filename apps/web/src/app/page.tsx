import { loadGoldenMatch } from '@/lib/match-fixture';
import { loadFixtureIndex } from '@/lib/fixtures';
import { fixtureDirectoryLabel } from '@/lib/fixture-status';
import { formatMatchClock } from '@/lib/clock';
import type { LandingFieldInput, TrajectoryRole } from '@/lib/landing-geometry';
import { LandingExperience } from './landing/landing-experience';
import './landing.css';

/**
 * Landing — the orb→stadium cinematic entry (KYN-09).
 *
 * The server loads the SAME golden fixture Explore renders and projects the
 * real geometry the fragment field will assemble into: the 22 checkpoint
 * player positions, the ball, and the three story trajectories (defender
 * away-03, striker home-09, decoy runner home-11 — the exact entities
 * Evidence X-Ray measures). One source of truth; no invented coordinates.
 */

const fixtureStatus = loadFixtureIndex();

/** Story entities whose measured runs the fragments assemble into. */
const STORY_ENTITIES: readonly { entityId: string; role: TrajectoryRole['role'] }[] = [
  { entityId: 'away-03', role: 'measured' },
  { entityId: 'home-09', role: 'measured' },
  { entityId: 'home-11', role: 'runner' },
];

/** Downsample stride: 10 Hz tracking → ~5 points/s keeps the payload tiny. */
const TRAJECTORY_STRIDE = 2;

function buildFieldInput(
  golden: Awaited<ReturnType<typeof loadGoldenMatch>>,
): LandingFieldInput | null {
  if (!golden.ok) return null;
  const { acceptedTracking } = golden.data.projected;
  const checkpointPlayers: {
    entityId: string;
    xM: number;
    yM: number;
  }[] = [];
  const [windowStart, windowEnd] = golden.data.goldenWindowMs;

  const seen = new Set<string>();
  for (const sample of acceptedTracking) {
    if (sample.sampleTimeMs !== golden.data.checkpointMs) continue;
    if (sample.entityId === 'ball' || seen.has(sample.entityId)) continue;
    seen.add(sample.entityId);
    checkpointPlayers.push({ entityId: sample.entityId, xM: sample.xM, yM: sample.yM });
  }
  let checkpointBall: LandingFieldInput['checkpointBall'] = null;
  for (const sample of acceptedTracking) {
    if (sample.sampleTimeMs === golden.data.checkpointMs && sample.entityId === 'ball') {
      checkpointBall = { xM: sample.xM, yM: sample.yM };
      break;
    }
  }

  const trajectories: TrajectoryRole[] = [];
  for (const { entityId, role } of STORY_ENTITIES) {
    const pointsM: { xM: number; yM: number }[] = [];
    let index = 0;
    for (const sample of acceptedTracking) {
      if (
        sample.entityId === entityId &&
        sample.sampleTimeMs >= windowStart &&
        sample.sampleTimeMs <= windowEnd
      ) {
        if (index % TRAJECTORY_STRIDE === 0) {
          pointsM.push({ xM: sample.xM, yM: sample.yM });
        }
        index += 1;
      }
    }
    if (pointsM.length >= 2) {
      trajectories.push({ entityId, role, pointsM });
    }
  }

  return {
    checkpointPlayers,
    checkpointBall,
    trajectories,
    fragmentCount: 0, // client decides by device budget
    seed: golden.data.seed,
  };
}

export default async function LandingPage() {
  const golden = await loadGoldenMatch();
  const fieldInput = buildFieldInput(golden);
  const clock = golden.ok ? formatMatchClock(golden.data.goldenWindowMs[0]) : null;
  const finalScore = golden.ok
    ? `${golden.data.finalScore.home}–${golden.data.finalScore.away}`
    : null;

  return (
    <main id="main-content" className="landing">
      <LandingExperience
        fixtureFacts={{
          matchClock: clock,
          finalScore,
          sampleCount: golden.ok ? golden.data.sampleCount : null,
          seed: golden.ok ? golden.data.seed : null,
          fixtureNote: fixtureDirectoryLabel(fixtureStatus),
          generatorVersion: golden.ok ? golden.data.generatorVersion : null,
        }}
        fieldInput={
          fieldInput ?? {
            checkpointPlayers: [],
            checkpointBall: null,
            trajectories: [],
            fragmentCount: 0,
            seed: 24017,
          }
        }
      />

      <section className="landing__chapters" aria-labelledby="chapters-title">
        <div className="container">
          <h2 id="chapters-title" className="landing__chapters-heading">
            One moment, four ways in
          </h2>
          <ol className="landing__chapters-list">
            <li>
              <span className="mono landing__chapters-index">01</span>
              <h3>Enter</h3>
              <p>
                Orbit the moment, scrub time, follow a player — 22 rigged footballers moving through
                the measured 78th-minute sequence.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">02</span>
              <h3>Understand</h3>
              <p>
                Evidence X-Ray ties every number to source frames — the measured 14&nbsp;m
                separation exists in the data, and the X-Ray proves it on the pitch.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">03</span>
              <h3>Direct</h3>
              <p>
                Producers shape camera tracks and overlays from typed proposals in Studio, with
                approval before anything ships.
              </p>
            </li>
            <li>
              <span className="mono landing__chapters-index">04</span>
              <h3>Publish</h3>
              <p>
                A versioned, embeddable Playable Moment — no release exists yet, and the viewer says
                so honestly.
              </p>
            </li>
          </ol>
          <p className="landing__fixture-note">
            Fixture seam: <span className="mono">{fixtureDirectoryLabel(fixtureStatus)}</span> ·
            provenance synthetic-ground-truth, generator{' '}
            {golden.ok ? <span className="mono">{golden.data.generatorVersion}</span> : '—'}
          </p>
        </div>
      </section>
    </main>
  );
}
