import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * KYN-01 acceptance: the workspace dependency direction is a tested rule,
 * not a convention. Allowed edges (KYN-02 added match-core -> contracts;
 * KYN-16 added moment-compiler -> contracts, match-core):
 *
 *   contracts       -> (no workspace dependencies)
 *   match-core      -> contracts
 *   scene-renderer  -> contracts, match-core
 *   moment-compiler -> contracts, match-core
 *   apps/*          -> any workspace package
 *
 * Any other edge — including cycles, undeclared imports, or a package under
 * packages/ importing an app — fails this test.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');
const appsDir = path.join(repoRoot, 'apps');

const ALLOWED_PACKAGE_EDGES: Record<string, readonly string[]> = {
  '@kyneloom/contracts': [],
  '@kyneloom/match-core': ['@kyneloom/contracts'],
  '@kyneloom/scene-renderer': ['@kyneloom/contracts', '@kyneloom/match-core'],
  '@kyneloom/moment-compiler': ['@kyneloom/contracts', '@kyneloom/match-core'],
};

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function workspaceDeps(pkgJson: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): string[] {
  return [
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
  ].filter((dep) => dep.startsWith('@kyneloom/'));
}

function importsIn(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /import\s+(?:[^'"]+\s+from\s+)?['"](@kyneloom\/[^'"]+)['"]/g,
    /export\s+[^'"]+\s+from\s+['"](@kyneloom\/[^'"]+)['"]/g,
    /import\(\s*['"](@kyneloom\/[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1] as string);
    }
  }
  return [...found];
}

describe('workspace package boundaries', () => {
  const packageDirs = readdirSync(packagesDir).map((name) => path.join(packagesDir, name));

  it('has the expected workspace packages', () => {
    expect(packageDirs.map((dir) => path.basename(dir)).sort()).toEqual([
      'contracts',
      'match-core',
      'moment-compiler',
      'scene-renderer',
    ]);
  });

  it('only declares allowed workspace dependencies in package.json', () => {
    for (const dir of packageDirs) {
      const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      const name = pkgJson['name'] as string;
      const allowed = ALLOWED_PACKAGE_EDGES[name];
      expect(
        allowed,
        `unknown workspace package ${name}; update ALLOWED_PACKAGE_EDGES`,
      ).toBeDefined();
      for (const dep of workspaceDeps(pkgJson as { dependencies?: Record<string, string> })) {
        expect(
          allowed,
          `${name} declares workspace dependency ${dep}, which is not in the allowed direction`,
        ).toContain(dep);
      }
    }
  });

  it('has no undeclared or disallowed workspace imports in package sources', () => {
    for (const dir of packageDirs) {
      const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      const name = pkgJson['name'] as string;
      const declared = workspaceDeps(pkgJson as { dependencies?: Record<string, string> });
      const allowed = ALLOWED_PACKAGE_EDGES[name] ?? [];

      const sources = walk(
        path.join(dir, 'src'),
        (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
      );
      for (const source of sources) {
        for (const imported of importsIn(readFileSync(source, 'utf-8'))) {
          expect(
            declared,
            `${path.relative(repoRoot, source)} imports ${imported} without declaring it in package.json`,
          ).toContain(imported);
          expect(
            allowed,
            `${path.relative(repoRoot, source)} imports ${imported}, which violates the dependency direction`,
          ).toContain(imported);
        }
      }
    }
  });

  it('is acyclic across all workspace dependency edges', () => {
    const graph = new Map<string, string[]>();
    for (const dir of [...packageDirs, ...readdirSync(appsDir).map((n) => path.join(appsDir, n))]) {
      const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      graph.set(
        pkgJson['name'] as string,
        workspaceDeps(pkgJson as { dependencies?: Record<string, string> }),
      );
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string, trail: string[]): void => {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        throw new Error(`workspace dependency cycle: ${[...trail, node].join(' -> ')}`);
      }
      visiting.add(node);
      for (const dep of graph.get(node) ?? []) visit(dep, [...trail, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(done.size).toBe(graph.size);
  });
});
