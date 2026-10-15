import { pitchAspectRatio } from '@kyneloom/scene-renderer';
import { loadFixtureIndex, type FixtureIndexStatus } from '@/lib/fixtures';

const REPO_DOCS_URL = 'https://github.com/CosmasMandikonza/Kyneloom/tree/main/docs';
const FIXTURES_README_URL = 'https://github.com/CosmasMandikonza/Kyneloom/tree/main/tests/fixtures';

const WORKING_TODAY = [
  'pnpm TypeScript monorepo with pinned Node and pnpm versions',
  'Shared packages: contracts (fixture-index seam), match-core (pitch geometry), scene-renderer (SSR-safe capabilities)',
  'Tested package-boundary rule — the renderer depends on the core, never the reverse',
  'Unit tests (Vitest) and application CI on GitHub Actions',
  'This foundation shell, rendered from the real design tokens',
];

const NOT_IMPLEMENTED = [
  {
    name: 'Living Replay (3D scene)',
    detail:
      'Rigged footballers, deterministic playback, cinematic cameras — issues KYN-06 to KYN-07, KYN-30.',
  },
  {
    name: 'Synthetic match generator and reducer',
    detail:
      'Seeded fixtures, canonical event stream, deterministic match state — issues KYN-02 to KYN-04.',
  },
  {
    name: 'Evidence X-Ray',
    detail: 'Measured geometry and labeled hypotheses anchored to source samples — issue KYN-08.',
  },
  {
    name: 'Foundry agents and Studio',
    detail: 'Typed proposals, producer review, approval and publishing — issues KYN-15 to KYN-18.',
  },
  {
    name: 'Broadcast overlay and embeddable Playable Moment',
    detail: 'Same validated manifest, additional output surfaces — issues KYN-19 and KYN-31.',
  },
];

function describeFixtureStatus(status: FixtureIndexStatus): {
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
} {
  switch (status.status) {
    case 'ok':
      return {
        tone: 'ok',
        title: `Valid index · schema ${status.index.schemaVersion} · ${status.index.fixtures.length} fixture${status.index.fixtures.length === 1 ? '' : 's'} registered`,
        detail:
          status.index.fixtures.length === 0
            ? 'No synthetic match data exists yet. This is the intentional empty state — the seeded fixture generator (KYN-03) will register payloads here.'
            : 'Registered test-harness fixtures are listed below.',
      };
    case 'unavailable':
      return {
        tone: 'warn',
        title: 'Fixture index unavailable',
        detail: `Reason: ${status.reason}. ${status.directory ? `Looked in ${status.directory}.` : 'No fixtures directory was resolved.'} The page continues without fixture data; nothing is fabricated.`,
      };
    case 'invalid':
      return {
        tone: 'warn',
        title: 'Fixture index invalid',
        detail: `${status.message} (${status.directory}). The page continues without fixture data; nothing is fabricated.`,
      };
  }
}

/** Show the workspace-relative path when we can, so the page does not bake in a local filesystem path. */
function displayDirectory(directory: string): string {
  const normalized = directory.replaceAll('\\', '/');
  const marker = '/tests/fixtures';
  const at = normalized.lastIndexOf(marker);
  return at === -1 ? normalized : normalized.slice(at + 1);
}

export default function HomePage() {
  const fixtureStatus = loadFixtureIndex();
  const fixtureSummary = describeFixtureStatus(fixtureStatus);
  const stageAspectRatio = pitchAspectRatio(); // 105 m × 68 m — one source with the future 3D canvas

  return (
    <div className="page">
      <header className="site-header">
        <div className="container site-header__inner">
          <span className="wordmark" aria-label="Kyneloom">
            KYNELOOM
          </span>
          <a
            className="site-header__link"
            href={REPO_DOCS_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            Documentation
            <span aria-hidden="true"> ↗</span>
          </a>
        </div>
      </header>

      <main id="main-content" className="container">
        <section className="hero" aria-labelledby="hero-title">
          <p className="hero__eyebrow">Repository foundation · Milestone M0</p>
          <h1 id="hero-title" className="hero__title">
            Every moment has a world inside.
          </h1>
          <p className="hero__lede">
            Kyneloom is an evidence-native experience engine for interactive sports: one trusted
            match moment, explorable in 3D, inspectable through evidence, and publishable as a
            playable experience. This deployment is the engineering foundation for that product — a
            typed monorepo with tested boundaries and a fixture seam. The interactive product itself
            is not implemented yet.
          </p>
          <ul className="hero__meta" aria-label="Foundation facts">
            <li>pnpm + TypeScript strict</li>
            <li>3 shared packages</li>
            <li>Vitest + CI on every push</li>
          </ul>
        </section>

        <section className="stage-section" aria-labelledby="stage-title">
          <div className="section-heading">
            <h2 id="stage-title">Living Replay</h2>
            <p className="chip chip--not-implemented">Not implemented</p>
          </div>
          <div
            className="scene-stage"
            style={{ '--pitch-ratio': String(stageAspectRatio) } as React.CSSProperties}
            data-testid="scene-stage"
            role="img"
            aria-label="Placeholder for the future interactive 3D replay scene, drawn as an abstract football pitch with correct 105 by 68 meter proportions"
          >
            <div className="scene-stage__lines" aria-hidden="true" />
            <div className="scene-stage__note">
              <p className="scene-stage__note-title">The 3D scene will render here</p>
              <p className="scene-stage__note-body">
                A React Three Fiber replay of timestamped synthetic match data, with cinematic
                cameras and evidence overlays (docs/08-3d-engine.md). Today this region only
                reserves the canvas area and its pitch proportions — nothing is rendered and no data
                is simulated.
              </p>
              <p className="scene-stage__note-planned">
                Planned surfaces: camera rig · evidence X-Ray · audience lenses · broadcast overlay
              </p>
            </div>
          </div>
        </section>

        <section className="status-section" aria-labelledby="status-title">
          <div className="section-heading">
            <h2 id="status-title">Foundation status</h2>
          </div>
          <div className="status-grid">
            <div className="status-panel">
              <h3>Working today</h3>
              <ul className="status-list status-list--working">
                {WORKING_TODAY.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="status-panel">
              <h3>Not implemented</h3>
              <ul className="status-list status-list--planned">
                {NOT_IMPLEMENTED.map((item) => (
                  <li key={item.name}>
                    <span className="status-list__name">{item.name}</span>
                    <span className="status-list__detail">{item.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="fixture-section" aria-labelledby="fixture-title">
          <div className="section-heading">
            <h2 id="fixture-title">Fixture seam</h2>
            <p
              className={`chip ${fixtureSummary.tone === 'ok' ? 'chip--ok' : 'chip--not-implemented'}`}
            >
              {fixtureSummary.tone === 'ok' ? 'Live read' : 'Degraded'}
            </p>
          </div>
          <div className="fixture-panel" data-testid="fixture-seam">
            <p className={`fixture-summary fixture-summary--${fixtureSummary.tone}`}>
              {fixtureSummary.title}
            </p>
            <p className="fixture-detail">{fixtureSummary.detail}</p>
            {fixtureStatus.status === 'ok' && fixtureStatus.index.fixtures.length > 0 ? (
              <ul className="fixture-list">
                {fixtureStatus.index.fixtures.map((fixture) => (
                  <li key={fixture.id}>
                    <span className="fixture-list__id">{fixture.id}</span>
                    <span className="fixture-list__label">{fixture.label}</span>
                    <span className="fixture-list__meta">
                      {fixture.generator} · seed {fixture.seed} · {fixture.file}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <dl className="fixture-meta">
              <div>
                <dt>Index source</dt>
                <dd>
                  {fixtureStatus.directory
                    ? `${displayDirectory(fixtureStatus.directory)} (index.json)`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Contract</dt>
                <dd>
                  @kyneloom/contracts · test-harness metadata, not the canonical football schema
                  (KYN-02)
                </dd>
              </div>
              <div>
                <dt>Format reference</dt>
                <dd>
                  <a href={FIXTURES_README_URL} rel="noopener noreferrer" target="_blank">
                    tests/fixtures/README.md
                    <span aria-hidden="true"> ↗</span>
                  </a>
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container site-footer__inner">
          <p>
            Kyneloom — built for the Microsoft × Premier League “Inside the Game” Hackathon.
            Foundation stage: product features are not implemented yet.
          </p>
          <p className="site-footer__muted">
            No fabricated match data, agent activity, or statistics appear on this page. Status
            claims update only with verifiable implementation.
          </p>
        </div>
      </footer>
    </div>
  );
}
