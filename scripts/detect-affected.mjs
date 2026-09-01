#!/usr/bin/env node
// Dependency-graph change detection for CI and deploy (shared by
// .github/workflows/ci.yml and cf-deploy.yml).
//
// Reads every apps/* and packages/* workspace package.json, builds the
// @rallypoint/* dependency graph, maps a git diff's changed files to
// their owning workspaces, and computes the reverse-dependency closure
// ("what is affected by this change"). Replaces the hand-maintained
// grep -E patterns that previously lived inline in cf-deploy.yml's
// paths-filter job — those drifted (the #609 api-kit gap) and once
// silently no-op'd the whole deploy matrix via an `echo | grep -q`
// SIGPIPE under pipefail (run 28489811553). This script uses no shell
// pipelines at all: git is invoked via execFileSync and $GITHUB_OUTPUT
// is written with appendFileSync.
//
// Two closure modes, because app→app package deps are TYPE-ONLY
// (`import type` — runtime coupling is wrangler [[services]] RPC
// bindings; see the type-only-edge guard in detect-affected.test.ts):
//   deploy — an edge whose dependency target is an apps/* workspace is
//            pruned: changing a producer app never requires redeploying
//            its consumers (their bundles embed only its types).
//   test   — all edges are followed: a producer's exported types feed
//            its consumers' compiles and test stubs, so consumers'
//            suites re-run. Deliberate over-approximation.
//
// Failure posture: unknown files fail OPEN (treated as global — run/
// deploy everything — with a ::warning:: annotation); internal errors
// fail LOUD (non-zero exit, red job). The catastrophic mode is a silent
// false negative, never a red job.
//
// CLI:
//   node scripts/detect-affected.mjs --mode <deploy|ci> \
//     (--base <ref> | --all) [--github-output]
//
//   --base <ref>       diff <ref> HEAD (two-dot; works on the shallow
//                      fetch-depth-2 checkout cf-deploy uses)
//   --all              skip the diff entirely: everything is affected
//                      (tag pushes, force_deploy_all, first commit)
//   --github-output    append key=value flags to $GITHUB_OUTPUT
//
// Output flags:
//   --mode deploy  the 10 flags cf-deploy.yml's downstream jobs consume:
//                  id_api events_api lists_api money_api planner_api
//                  fitness_api admin_api ai_api www lists_mcp
//   --mode ci      code_changed docs_only d1_{id,lists,events,money,
//                  planner,fitness,admin,ai} workers_tests objstore_tests

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Deploy-target table — the ONLY hand-maintained mapping. Each cf-deploy
// output flag ← the workspace dirs whose changes require that deploy (a
// web SPA is baked into its API Worker's assets at deploy time, so the
// web app maps to the API's flag). detect-affected.test.ts asserts every
// apps/* workspace appears in exactly one entry and every listed dir
// exists, so adding an app without mapping it here fails CI loudly.
export const DEPLOY_TARGETS = {
  id_api: ['apps/id-api', 'apps/id-web'],
  events_api: ['apps/events-api', 'apps/events-web'],
  lists_api: ['apps/lists-api', 'apps/lists-web'],
  money_api: ['apps/money-api', 'apps/money-web'],
  planner_api: ['apps/planner-api', 'apps/planner-web'],
  fitness_api: ['apps/fitness-api', 'apps/fitness-web'],
  admin_api: ['apps/admin-api', 'apps/admin-web'],
  ai_api: ['apps/ai-api'],
  www: ['apps/www'],
  lists_mcp: ['apps/lists-mcp'],
}

// D1 suite flags ← the API app whose vitest.d1.config.ts the suite runs.
export const D1_SUITES = {
  d1_id: 'apps/id-api',
  d1_lists: 'apps/lists-api',
  d1_events: 'apps/events-api',
  d1_money: 'apps/money-api',
  d1_planner: 'apps/planner-api',
  d1_fitness: 'apps/fitness-api',
  d1_admin: 'apps/admin-api',
  d1_ai: 'apps/ai-api',
}

// Workers-pool suite flags ← the package whose vitest.workers.config.ts
// the suite runs.
export const WORKERS_SUITES = {
  workers_tests: 'packages/realtime',
  objstore_tests: 'packages/object-store',
  rate_limit_workers_tests: 'packages/rate-limit',
}

// Graph edges that exist in the build but NOT in any package.json.
// packages/analytics is wired into every web SPA via a Vite alias
// (`virtual:analytics` in apps/*/vite.config.ts) instead of a declared
// dependency, so FOSS mirror builds work with the package stripped —
// which makes it invisible to the package.json graph. Each entry adds
// "these workspaces depend on this one". detect-affected.test.ts pins
// this table against the vite.config.ts files (both directions), so a
// new aliased consumer or a removed alias fails the suite.
export const UNDECLARED_DEPS = {
  'packages/analytics': [
    'apps/admin-web',
    'apps/events-web',
    'apps/fitness-web',
    'apps/id-web',
    'apps/lists-web',
    'apps/money-web',
    'apps/planner-web',
    'apps/www',
  ],
}

// ---------------------------------------------------------------------------
// Workspace graph

/**
 * Load every apps/* and packages/* workspace (dirs with a package.json).
 * @param {string} rootDir
 * @returns {Map<string, {dir: string, name: string, deps: string[]}>}
 *   keyed by workspace dir (e.g. "apps/id-api"); deps are workspace DIRS
 *   (resolved from @rallypoint/* package names — apps/www is named
 *   @rallypoint/www-web, so dirs, not names, are the identity).
 */
export function loadWorkspaces(rootDir) {
  /** @type {Map<string, {dir: string, name: string, rawDeps: string[]}>} */
  const byDir = new Map()
  for (const parent of ['apps', 'packages']) {
    for (const entry of readdirSync(join(rootDir, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue
      const dir = `${parent}/${entry.name}`
      const pkgPath = join(rootDir, dir, 'package.json')
      if (!existsSync(pkgPath)) continue // build-cache ghost dirs
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const rawDeps = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      }).filter((n) => n.startsWith('@rallypoint/'))
      byDir.set(dir, { dir, name: pkg.name, rawDeps })
    }
  }
  const dirByName = new Map([...byDir.values()].map((w) => [w.name, w.dir]))
  const workspaces = new Map()
  for (const { dir, name, rawDeps } of byDir.values()) {
    const deps = rawDeps.map((n) => {
      const depDir = dirByName.get(n)
      if (!depDir)
        throw new Error(
          `${dir}/package.json depends on ${n}, which is not a workspace`,
        )
      return depDir
    })
    workspaces.set(dir, { dir, name, deps })
  }
  for (const [dep, consumers] of Object.entries(UNDECLARED_DEPS)) {
    if (!workspaces.has(dep))
      throw new Error(`UNDECLARED_DEPS: ${dep} is not a workspace`)
    for (const consumer of consumers) {
      const w = workspaces.get(consumer)
      if (!w)
        throw new Error(`UNDECLARED_DEPS: ${consumer} is not a workspace`)
      if (!w.deps.includes(dep)) w.deps.push(dep)
    }
  }
  return workspaces
}

// ---------------------------------------------------------------------------
// File classification

// Root files that invalidate everything (lockfile/toolchain/config).
const GLOBAL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'eslint.config.js',
  'vitest.config.ts',
  'vitest.setup.ts',
  'scripts/detect-affected.mjs', // changing the filter re-runs everything
  '.github/workflows/ci.yml',
  '.github/workflows/cf-deploy.yml',
  '.github/workflows/cf-deploy-app.yml',
])

// Prose/meta files — never affect tests or deploys. Any *.md anywhere
// (README, CLAUDE.md, docs inside workspaces) is docs too.
const DOCS_PREFIXES = ['docs/']
const DOCS_FILES = new Set([
  'LICENSE',
  'NOTICE',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
])

// Editor/agent config — affects nothing, not even "code changed".
const NOOP_PREFIXES = ['.claude/', '.vscode/', '.github/ISSUE_TEMPLATE/']

// Code that belongs to no workspace: linted, typechecked, and covered by
// the root vitest run, but drives no deploy and no per-app suite.
const CODE_UNOWNED_PREFIXES = ['scripts/', 'tools/', 'e2e/', 'spikes/']

/**
 * @param {string} path repo-relative changed file path
 * @param {Map<string, {dir: string}>} workspaces from loadWorkspaces
 * @returns {{kind: 'docs'|'noop'|'global'|'code-unowned'|'workspace',
 *            workspace?: string, warning?: string}}
 */
export function classifyFile(path, workspaces) {
  if (GLOBAL_FILES.has(path)) return { kind: 'global' }
  if (NOOP_PREFIXES.some((p) => path.startsWith(p))) return { kind: 'noop' }
  if (
    path.endsWith('.md') ||
    DOCS_FILES.has(path) ||
    DOCS_PREFIXES.some((p) => path.startsWith(p))
  )
    return { kind: 'docs' }
  const m = path.match(/^(apps|packages)\/([^/]+)\//)
  if (m) {
    const dir = `${m[1]}/${m[2]}`
    if (workspaces.has(dir)) return { kind: 'workspace', workspace: dir }
    // A dir under apps/ or packages/ that isn't a workspace — fail open.
    return {
      kind: 'global',
      warning: `${path}: ${dir} is not a workspace — running everything`,
    }
  }
  if (CODE_UNOWNED_PREFIXES.some((p) => path.startsWith(p)))
    return { kind: 'code-unowned' }
  // Remaining .github/** (e.g. mirror-open.yml) doesn't affect tests or
  // deploys of the apps themselves.
  if (path.startsWith('.github/')) return { kind: 'noop' }
  // Unknown file — fail open, loudly.
  return {
    kind: 'global',
    warning: `${path}: unclassified — running everything`,
  }
}

// ---------------------------------------------------------------------------
// Closure

/**
 * @param {string[]} changedFiles
 * @param {Map<string, {dir: string, deps: string[]}>} workspaces
 * @param {'deploy'|'test'} mode edge policy: 'deploy' prunes edges whose
 *   dependency target is an apps/* workspace (type-only imports; RPC at
 *   runtime); 'test' follows every edge.
 * @returns {{affected: Set<string>, global: boolean, codeChanged: boolean,
 *            docsOnly: boolean, warnings: string[],
 *            classified: Array<{path: string, kind: string, workspace?: string}>}}
 */
export function computeAffected(changedFiles, workspaces, mode) {
  if (mode !== 'deploy' && mode !== 'test')
    throw new Error(`unknown closure mode: ${mode}`)
  const warnings = []
  const classified = []
  const seeds = new Set()
  let global = false
  let codeChanged = false
  for (const path of changedFiles) {
    const c = classifyFile(path, workspaces)
    classified.push({ path, kind: c.kind, workspace: c.workspace })
    if (c.warning) warnings.push(c.warning)
    if (c.kind !== 'docs' && c.kind !== 'noop') codeChanged = true
    if (c.kind === 'global') global = true
    if (c.kind === 'workspace') seeds.add(c.workspace)
  }

  // Reverse edges: dep dir → dirs that depend on it.
  const dependents = new Map()
  for (const w of workspaces.values()) {
    for (const dep of w.deps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep).push(w.dir)
    }
  }

  const affected = new Set()
  if (global) {
    for (const dir of workspaces.keys()) affected.add(dir)
  } else {
    const queue = [...seeds]
    while (queue.length > 0) {
      const dir = queue.shift()
      if (affected.has(dir)) continue
      affected.add(dir)
      // deploy mode: an app's change never propagates to its dependents
      // (type-only edges — see header comment).
      if (mode === 'deploy' && dir.startsWith('apps/')) continue
      for (const dependent of dependents.get(dir) ?? []) queue.push(dependent)
    }
  }

  return {
    affected,
    global,
    codeChanged,
    docsOnly: !codeChanged,
    warnings,
    classified,
  }
}

/**
 * Flatten a closure result into the output flags for a mode.
 * @param {'deploy'|'ci'} mode
 * @param {ReturnType<typeof computeAffected>} result
 * @returns {Record<string, string>} flag → 'true'|'false'
 */
export function buildFlags(mode, result) {
  const { affected } = result
  /** @type {Record<string, string>} */
  const flags = {}
  if (mode === 'deploy') {
    for (const [flag, dirs] of Object.entries(DEPLOY_TARGETS)) {
      flags[flag] = String(dirs.some((d) => affected.has(d)))
    }
  } else {
    flags.code_changed = String(result.codeChanged)
    flags.docs_only = String(result.docsOnly)
    for (const [flag, dir] of Object.entries(D1_SUITES)) {
      flags[flag] = String(affected.has(dir))
    }
    for (const [flag, dir] of Object.entries(WORKERS_SUITES)) {
      flags[flag] = String(affected.has(dir))
    }
  }
  return flags
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { mode: '', base: '', all: false, githubOutput: false }
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--mode':
        args.mode = argv[++i] ?? ''
        break
      case '--base':
        args.base = argv[++i] ?? ''
        break
      case '--all':
        args.all = true
        break
      case '--github-output':
        args.githubOutput = true
        break
      default:
        throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (args.mode !== 'deploy' && args.mode !== 'ci')
    throw new Error(`--mode must be deploy or ci (got "${args.mode}")`)
  if (args.all === Boolean(args.base))
    throw new Error('pass exactly one of --base <ref> or --all')
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const workspaces = loadWorkspaces(rootDir)
  const closureMode = args.mode === 'deploy' ? 'deploy' : 'test'

  let result
  if (args.all) {
    console.log('Change detection disabled (--all): everything is affected.')
    result = {
      affected: new Set(workspaces.keys()),
      global: true,
      codeChanged: true,
      docsOnly: false,
      warnings: [],
      classified: [],
    }
  } else {
    // Two-dot diff, matching the previous paths-filter behavior — it
    // works on cf-deploy's shallow fetch-depth-2 checkout, and on a PR's
    // merge-ref checkout (HEAD already contains the latest base tip) it
    // yields exactly the PR's changes.
    const out = execFileSync(
      'git',
      ['diff', '--name-only', args.base, 'HEAD'],
      { cwd: rootDir, encoding: 'utf8' },
    )
    const changedFiles = out.split('\n').filter(Boolean)
    result = computeAffected(changedFiles, workspaces, closureMode)

    console.log(`Changed files vs ${args.base}:`)
    if (result.classified.length === 0) console.log('  (none)')
    for (const c of result.classified) {
      console.log(`  ${c.path}  [${c.workspace ?? c.kind}]`)
    }
    if (result.global) {
      console.log('Global trip (config/lockfile/workflow): everything runs.')
    } else {
      console.log(`Affected workspaces (${closureMode} closure):`)
      if (result.affected.size === 0) console.log('  (none)')
      for (const dir of [...result.affected].sort()) console.log(`  ${dir}`)
    }
  }

  for (const w of result.warnings) console.log(`::warning::${w}`)

  const flags = buildFlags(args.mode, result)
  console.log('Flags:')
  for (const [k, v] of Object.entries(flags)) console.log(`  ${k}=${v}`)

  if (args.githubOutput) {
    const outFile = process.env.GITHUB_OUTPUT
    if (!outFile)
      throw new Error('--github-output passed but $GITHUB_OUTPUT is unset')
    const lines = Object.entries(flags)
      .map(([k, v]) => `${k}=${v}\n`)
      .join('')
    appendFileSync(outFile, lines)
  }
}

// Run the CLI only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
