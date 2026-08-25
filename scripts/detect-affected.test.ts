import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  D1_SUITES,
  DEPLOY_TARGETS,
  UNDECLARED_DEPS,
  WORKERS_SUITES,
  buildFlags,
  classifyFile,
  computeAffected,
  loadWorkspaces,
  // @ts-ignore — plain .mjs module, no type declarations
} from './detect-affected.mjs'

// Guards the dependency-graph change detection shared by ci.yml and
// cf-deploy.yml. Successor to scripts/deploy-path-filter.test.ts (which
// parsed the grep -E patterns this script replaced) — same protection
// class: a workspace whose changes deploy/test NOTHING is the #609
// stale-SessionVerifier incident shape, silently shipped.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

type Workspace = { dir: string; name: string; deps: string[] }
type Affected = {
  affected: Set<string>
  global: boolean
  codeChanged: boolean
  docsOnly: boolean
  warnings: string[]
}

/** Build a synthetic workspace map for fixture tests. */
function fixture(entries: Array<[string, string[]]>): Map<string, Workspace> {
  return new Map(
    entries.map(([dir, deps]) => [
      dir,
      { dir, name: `@rallypoint/${dir.split('/')[1]}`, deps },
    ]),
  )
}

describe('computeAffected (fixture graphs)', () => {
  // apps/a-api → packages/p1 → packages/p2; apps/b-api → packages/p1
  // apps/c-api → apps/a-api (type-only app→app edge)
  const graph = fixture([
    ['apps/a-api', ['packages/p1']],
    ['apps/b-api', ['packages/p1']],
    ['apps/c-api', ['apps/a-api']],
    ['packages/p1', ['packages/p2']],
    ['packages/p2', []],
  ])

  it('direct hit affects only that workspace and its dependents', () => {
    const r: Affected = computeAffected(
      ['apps/b-api/src/index.ts'],
      graph,
      'deploy',
    )
    expect([...r.affected].sort()).toEqual(['apps/b-api'])
    expect(r.codeChanged).toBe(true)
    expect(r.docsOnly).toBe(false)
  })

  it('transitive package chain reaches all dependents', () => {
    const r: Affected = computeAffected(
      ['packages/p2/src/index.ts'],
      graph,
      'test',
    )
    expect([...r.affected].sort()).toEqual([
      'apps/a-api',
      'apps/b-api',
      'apps/c-api', // via a-api in test mode
      'packages/p1',
      'packages/p2',
    ])
  })

  it('deploy mode prunes app→app edges; test mode follows them', () => {
    const deploy: Affected = computeAffected(
      ['apps/a-api/src/index.ts'],
      graph,
      'deploy',
    )
    expect(deploy.affected.has('apps/c-api')).toBe(false)
    const test: Affected = computeAffected(
      ['apps/a-api/src/index.ts'],
      graph,
      'test',
    )
    expect(test.affected.has('apps/c-api')).toBe(true)
  })

  it('deploy mode still traverses package chains below an app', () => {
    // p2 → p1 → a-api → (pruned) c-api: the prune applies only to edges
    // LEAVING an app workspace, not to reaching apps via packages.
    const r: Affected = computeAffected(
      ['packages/p2/src/index.ts'],
      graph,
      'deploy',
    )
    expect(r.affected.has('apps/a-api')).toBe(true)
    expect(r.affected.has('apps/b-api')).toBe(true)
    expect(r.affected.has('apps/c-api')).toBe(false)
  })

  it('diamond dependencies are visited once, no infinite loop', () => {
    const diamond = fixture([
      ['apps/top-api', ['packages/left', 'packages/right']],
      ['packages/left', ['packages/base']],
      ['packages/right', ['packages/base']],
      ['packages/base', []],
    ])
    const r: Affected = computeAffected(
      ['packages/base/src/index.ts'],
      diamond,
      'test',
    )
    expect(r.affected.size).toBe(4)
  })

  it('docs-only changes affect nothing', () => {
    const r: Affected = computeAffected(
      ['README.md', 'docs/design/planner-v1.md', 'apps/a-api/NOTES.md'],
      graph,
      'test',
    )
    expect(r.affected.size).toBe(0)
    expect(r.codeChanged).toBe(false)
    expect(r.docsOnly).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('noop files (agent/editor config) affect nothing', () => {
    const r: Affected = computeAffected(
      ['.claude/settings.json', '.vscode/launch.json'],
      graph,
      'test',
    )
    expect(r.codeChanged).toBe(false)
    expect(r.affected.size).toBe(0)
  })

  it('global config files trip everything', () => {
    const r: Affected = computeAffected(['package-lock.json'], graph, 'deploy')
    expect(r.global).toBe(true)
    expect(r.affected.size).toBe(graph.size)
    expect(r.docsOnly).toBe(false)
  })

  it('unknown files fail open to global with a warning', () => {
    const r: Affected = computeAffected(['mystery.bin'], graph, 'deploy')
    expect(r.global).toBe(true)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('mystery.bin')
  })

  it('non-workspace dirs under apps/ fail open with a warning', () => {
    const r: Affected = computeAffected(
      ['apps/ghost-api/src/index.ts'],
      graph,
      'deploy',
    )
    expect(r.global).toBe(true)
    expect(r.warnings).toHaveLength(1)
  })

  it('code-unowned files set codeChanged but affect no workspace', () => {
    const r: Affected = computeAffected(
      ['scripts/dev.sh', 'e2e/smoke.spec.ts', 'tools/x.ts'],
      graph,
      'test',
    )
    expect(r.codeChanged).toBe(true)
    expect(r.docsOnly).toBe(false)
    expect(r.affected.size).toBe(0)
    expect(r.global).toBe(false)
  })

  it('empty diff affects nothing and counts as docs-only', () => {
    const r: Affected = computeAffected([], graph, 'test')
    expect(r.affected.size).toBe(0)
    expect(r.codeChanged).toBe(false)
    expect(r.docsOnly).toBe(true)
  })

  it('rejects an unknown closure mode', () => {
    expect(() => computeAffected([], graph, 'wat')).toThrow(/mode/)
  })
})

describe('classifyFile', () => {
  const graph = fixture([['apps/a-api', []]])
  it.each([
    ['ARCHITECTURE.md', 'docs'],
    ['LICENSE', 'docs'],
    ['.gitignore', 'docs'],
    ['docs/audit/x.txt', 'docs'],
    ['.claude/worktrees/x/y.ts', 'noop'],
    ['.github/ISSUE_TEMPLATE/bug.yml', 'noop'],
    ['.github/workflows/mirror-open.yml', 'noop'],
    ['.github/workflows/ci.yml', 'global'],
    ['.github/workflows/cf-deploy.yml', 'global'],
    ['.github/workflows/cf-deploy-app.yml', 'global'],
    ['scripts/detect-affected.mjs', 'global'],
    ['eslint.config.js', 'global'],
    ['vitest.config.ts', 'global'],
    ['tsconfig.base.json', 'global'],
    ['scripts/check-migrations.sh', 'code-unowned'],
    ['spikes/d1-transactions/x.ts', 'code-unowned'],
    ['apps/a-api/src/index.ts', 'workspace'],
  ])('%s → %s', (path, kind) => {
    expect(classifyFile(path, graph).kind).toBe(kind)
  })

  it('workspace package.json is workspace-owned, root package.json global', () => {
    expect(classifyFile('apps/a-api/package.json', graph).kind).toBe(
      'workspace',
    )
    expect(classifyFile('package.json', graph).kind).toBe('global')
  })
})

// ---------------------------------------------------------------------------
// Real-repo drift guards

const workspaces: Map<string, Workspace> = loadWorkspaces(ROOT)
const appDirs = [...workspaces.keys()].filter((d) => d.startsWith('apps/'))
const packageDirs = [...workspaces.keys()].filter((d) =>
  d.startsWith('packages/'),
)

describe('real-repo invariants', () => {
  it('every apps/* workspace appears in exactly one DEPLOY_TARGETS entry', () => {
    const mapped = Object.values(DEPLOY_TARGETS).flat()
    for (const dir of appDirs) {
      const count = mapped.filter((d) => d === dir).length
      expect(
        count,
        `${dir} appears in ${count} DEPLOY_TARGETS entries (want exactly 1) — ` +
          `a new app must be mapped to a deploy flag in scripts/detect-affected.mjs`,
      ).toBe(1)
    }
  })

  it('every DEPLOY_TARGETS / suite dir exists as a workspace (no dead entries)', () => {
    for (const dir of [
      ...Object.values(DEPLOY_TARGETS).flat(),
      ...Object.values(D1_SUITES),
      ...Object.values(WORKERS_SUITES),
    ]) {
      expect(workspaces.has(dir), `${dir} is not a workspace on disk`).toBe(
        true,
      )
    }
  })

  it.each(packageDirs)('%s deploy-reaches at least one app', (pkg) => {
    const r: Affected = computeAffected(
      [`${pkg}/src/index.ts`],
      workspaces,
      'deploy',
    )
    const flags = buildFlags('deploy', r)
    const deploysSomething = Object.values(flags).some((v) => v === 'true')
    expect(
      deploysSomething,
      `a commit touching only ${pkg} would deploy NOTHING — the #609 ` +
        `incident shape. If this package is genuinely dev-only, add it to ` +
        `an explicit allowlist here.`,
    ).toBe(true)
  })

  it('every @rallypoint/* dep resolves to a workspace (loadWorkspaces throws otherwise)', () => {
    // loadWorkspaces already threw above if not; assert shape here.
    expect(workspaces.size).toBeGreaterThan(30)
    for (const w of workspaces.values()) {
      for (const dep of w.deps) expect(workspaces.has(dep)).toBe(true)
    }
  })

  it('UNDECLARED_DEPS matches the vite.config.ts analytics aliases both ways', () => {
    // packages/analytics is consumed via a `virtual:analytics` Vite
    // alias, not a package.json dep (FOSS mirror builds strip the
    // package) — the graph edge is hand-added in UNDECLARED_DEPS.
    const aliased = appDirs.filter((dir) => {
      const vite = join(ROOT, dir, 'vite.config.ts')
      return (
        existsSync(vite) &&
        readFileSync(vite, 'utf8').includes('@rallypoint/analytics')
      )
    })
    expect(aliased.sort()).toEqual(
      [...UNDECLARED_DEPS['packages/analytics']].sort(),
    )
  })

  it('every D1 suite in root package.json has a flag and vice versa', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const suiteScripts = Object.keys(pkg.scripts).filter((s) =>
      s.startsWith('test:d1'),
    )
    // One flag per test:d1* script (test:d1 = id, test:d1:<x> = <x>).
    expect(suiteScripts).toHaveLength(Object.keys(D1_SUITES).length)
    for (const [, dir] of Object.entries(D1_SUITES)) {
      expect(
        existsSync(join(ROOT, dir, 'vitest.d1.config.ts')),
        `${dir} has no vitest.d1.config.ts`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Type-only-edge guard: deploy-mode pruning assumes no app bundles
// another app's runtime code. If someone starts value-importing an
// @rallypoint/*-api package, the pruned deploy closure silently
// under-deploys — fail red here instead.

describe('app→app imports stay type-only', () => {
  const apiPackageNames = new Set(
    [...workspaces.values()]
      .filter((w) => w.dir.startsWith('apps/'))
      .map((w) => w.name),
  )

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        yield* sourceFiles(full)
      } else if (
        /\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry.name) &&
        // Test files may value-import app packages for stubs/fixtures —
        // they're never bundled into a deployed Worker, so they don't
        // threaten the deploy-mode pruning this guard protects.
        !/\.(test|spec)\.(ts|tsx|mts)$/.test(entry.name)
      ) {
        yield full
      }
    }
  }

  it('no value imports of app packages anywhere in apps/ or packages/', () => {
    const offenders: string[] = []
    // Matches `import ... from '@rallypoint/x'` and `export ... from ...`
    // (single statement, possibly multi-line); `import type` is exempt.
    const importRe =
      /(import|export)\s+(type\s+)?[^;]*?from\s+['"](@rallypoint\/[\w-]+)['"]/gs
    for (const parent of ['apps', 'packages']) {
      for (const file of sourceFiles(join(ROOT, parent))) {
        const text = readFileSync(file, 'utf8')
        for (const m of text.matchAll(importRe)) {
          if (!apiPackageNames.has(m[3])) continue
          if (m[2]) continue // import type / export type
          offenders.push(
            `${file.slice(ROOT.length)}: value-imports ${m[3]} — deploy-mode ` +
              `edge pruning in scripts/detect-affected.mjs assumes app→app ` +
              `imports are type-only (runtime coupling is RPC bindings)`,
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Workflow-consistency guards: the flags the script emits must match what
// the YAML consumes, or a rename silently turns a gate into 'false'.

describe('workflow consistency', () => {
  const cfDeploy = readFileSync(
    join(ROOT, '.github/workflows/cf-deploy.yml'),
    'utf8',
  )
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')

  it('cf-deploy.yml exposes exactly the deploy flags', () => {
    for (const flag of Object.keys(DEPLOY_TARGETS)) {
      expect(
        cfDeploy,
        `cf-deploy.yml does not wire paths-filter output ${flag}`,
      ).toContain(`${flag}: \${{ steps.f.outputs.${flag} }}`)
    }
  })

  it('cf-deploy.yml calls the script in deploy mode', () => {
    expect(cfDeploy).toContain('scripts/detect-affected.mjs')
    expect(cfDeploy).toContain('--mode deploy')
  })

  it('ci.yml consumes every ci-mode flag', () => {
    const ciFlags = [
      'code_changed',
      ...Object.keys(D1_SUITES),
      ...Object.keys(WORKERS_SUITES),
    ]
    for (const flag of ciFlags) {
      expect(
        ci,
        `ci.yml never reads needs.changes.outputs.${flag} — its suite would run unconditionally or never`,
      ).toContain(`needs.changes.outputs.${flag}`)
    }
    expect(ci).toContain('--mode ci')
  })
})

// ---------------------------------------------------------------------------
// CLI contract: GITHUB_OUTPUT format + exit codes, via a child process.

describe('CLI', () => {
  const script = join(ROOT, 'scripts/detect-affected.mjs')

  it('writes key=value flags to GITHUB_OUTPUT with --all', () => {
    const outFile = join(mkdtempSync(join(tmpdir(), 'detect-')), 'out')
    execFileSync(
      process.execPath,
      [script, '--mode', 'deploy', '--all', '--github-output'],
      { env: { ...process.env, GITHUB_OUTPUT: outFile }, cwd: ROOT },
    )
    const lines = readFileSync(outFile, 'utf8').trim().split('\n')
    expect(lines.sort()).toEqual(
      Object.keys(DEPLOY_TARGETS)
        .map((f) => `${f}=true`)
        .sort(),
    )
  })

  it('ci mode with --all sets code_changed=true and all suites', () => {
    const outFile = join(mkdtempSync(join(tmpdir(), 'detect-')), 'out')
    execFileSync(
      process.execPath,
      [script, '--mode', 'ci', '--all', '--github-output'],
      { env: { ...process.env, GITHUB_OUTPUT: outFile }, cwd: ROOT },
    )
    const out = readFileSync(outFile, 'utf8')
    expect(out).toContain('code_changed=true')
    expect(out).toContain('docs_only=false')
    expect(out).toContain('d1_planner=true')
    expect(out).toContain('objstore_tests=true')
  })

  it.each([
    [['--mode', 'nope', '--all'], /--mode/],
    [['--mode', 'ci'], /--base|--all/],
    [['--mode', 'ci', '--all', '--base', 'HEAD~1'], /--base|--all/],
    [['--mode', 'ci', '--all', '--wat'], /unknown argument/],
  ])('exits non-zero on bad args %j', (args, msg) => {
    expect(() =>
      execFileSync(process.execPath, [script, ...(args as string[])], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).toThrow(msg)
  })

  it('exits non-zero when --github-output is passed without GITHUB_OUTPUT', () => {
    const env = { ...process.env }
    delete env.GITHUB_OUTPUT
    expect(() =>
      execFileSync(
        process.execPath,
        [script, '--mode', 'ci', '--all', '--github-output'],
        { cwd: ROOT, env, stdio: 'pipe' },
      ),
    ).toThrow(/GITHUB_OUTPUT/)
  })
})
