import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

// scripts/check-migrations.sh lints newly-added D1 migration files for
// destructive SQL (DROP TABLE, DROP COLUMN, ALTER ... RENAME, ADD COLUMN
// NOT NULL without DEFAULT). These tests spin up a throwaway git repo,
// commit a baseline + a new "candidate" migration, and run the real
// script against `BASELINE...HEAD` — exercising the actual `git diff
// --diff-filter=A` path the script uses.
//
// Audit E3 #21: the glob now covers BOTH packages/<scope>-db/migrations/
// AND apps/<app>-api/migrations/, so the dedicated "apps/* path is
// scanned" test guards against a regression to packages-only.

const SCRIPT = fileURLToPath(new URL('./check-migrations.sh', import.meta.url))

function git(repo: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
}

function configureRepo(repo: string): void {
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
}

function commitFile(
  repo: string,
  relPath: string,
  content: string,
  message: string,
): void {
  const full = join(repo, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  git(repo, 'add', relPath)
  git(repo, 'commit', '-q', '-m', message)
}

function runLinter(repo: string, baseRef: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('bash', [SCRIPT, baseRef], {
    cwd: repo,
    encoding: 'utf8',
  })
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

describe('check-migrations.sh', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'check-migrations-'))
    configureRepo(repo)
    // Baseline commit so we have a ref to diff against.
    commitFile(repo, 'README.md', '# fixture', 'baseline')
    git(repo, 'tag', 'baseline')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('passes when no new migration files were added', () => {
    commitFile(repo, 'docs/note.md', 'unrelated change', 'docs only')
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('flags a destructive packages/ migration', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_drop.sql',
      'DROP TABLE example;\n',
      'destructive packages migration',
    )
    const { code, stdout } = runLinter(repo, 'baseline')
    expect(code).toBe(1)
    expect(stdout).toMatch(/DROP TABLE/i)
  })

  // E3 #21: the previous MIGRATION_GLOB was packages-only, so this would
  // have falsely exited 0 ("no new migration files") for an apps/-rooted
  // destructive migration. The current glob covers both.
  it('flags a destructive apps/<app>-api/migrations/ migration', () => {
    commitFile(
      repo,
      'apps/example-api/migrations/0001_drop_column.sql',
      'ALTER TABLE example DROP COLUMN secret;\n',
      'destructive apps migration',
    )
    const { code, stdout } = runLinter(repo, 'baseline')
    expect(code).toBe(1)
    expect(stdout).toMatch(/DROP COLUMN/i)
  })

  it('passes a safe ADD COLUMN with DEFAULT under apps/', () => {
    commitFile(
      repo,
      'apps/example-api/migrations/0001_add_col.sql',
      "ALTER TABLE example ADD COLUMN status text NOT NULL DEFAULT 'pending';\n",
      'safe additive migration',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('honours the per-line opt-out comment on apps/ migrations', () => {
    commitFile(
      repo,
      'apps/example-api/migrations/0001_drop_with_optout.sql',
      'DROP TABLE legacy; -- migration-lint: allow-destructive\n',
      'opted-out destructive migration',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  // #824: drizzle-kit's SQLite output omits the COLUMN keyword, so the bare
  // `ALTER TABLE x ADD col ... NOT NULL` (no DEFAULT) form used to slip the
  // lint entirely. It must now be flagged like the explicit `ADD COLUMN` form.
  it('flags a bare drizzle-style ADD (no COLUMN keyword) NOT NULL without DEFAULT', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_bare_add.sql',
      'ALTER TABLE `example` ADD `flag` integer NOT NULL;\n',
      'bare add not null',
    )
    const { code, stdout } = runLinter(repo, 'baseline')
    expect(code).toBe(1)
    expect(stdout).toMatch(/NOT NULL without DEFAULT/i)
  })

  it('passes a bare drizzle-style ADD with DEFAULT before NOT NULL', () => {
    // The exact shape drizzle-kit emits (packages/db/migrations/0002_*.sql).
    commitFile(
      repo,
      'packages/example-db/migrations/0001_bare_add_default.sql',
      'ALTER TABLE `example` ADD `count` integer DEFAULT 0 NOT NULL;\n',
      'bare add with default',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('passes a bare ADD with NOT NULL before DEFAULT', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_bare_add_default2.sql',
      "ALTER TABLE `example` ADD `set_type` text NOT NULL DEFAULT 'working';\n",
      'bare add not null then default',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('still flags the explicit ADD COLUMN NOT NULL without DEFAULT (unchanged)', () => {
    commitFile(
      repo,
      'apps/example-api/migrations/0001_add_column_notnull.sql',
      'ALTER TABLE example ADD COLUMN flag integer NOT NULL;\n',
      'explicit add column not null',
    )
    const { code, stdout } = runLinter(repo, 'baseline')
    expect(code).toBe(1)
    expect(stdout).toMatch(/NOT NULL without DEFAULT/i)
  })

  it('does not flag a table-level ADD CONSTRAINT that mentions NOT NULL', () => {
    // Not a column add — the CONSTRAINT/PRIMARY/etc. exclusion must spare it.
    commitFile(
      repo,
      'packages/example-db/migrations/0001_add_constraint.sql',
      'ALTER TABLE example ADD CONSTRAINT ck CHECK (flag IS NOT NULL);\n',
      'add constraint',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('honours the opt-out on a bare ADD NOT NULL line', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_bare_add_optout.sql',
      'ALTER TABLE `example` ADD `flag` integer NOT NULL; -- migration-lint: allow-destructive\n',
      'opted-out bare add',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  // The ALTER-TABLE anchor exists so a brand-new CREATE TABLE with NOT NULL
  // columns (legitimate — a new table has no existing rows to break) is never
  // flagged, even though the line contains `NOT NULL` and no DEFAULT.
  it('does not flag a CREATE TABLE with NOT NULL columns', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_create.sql',
      'CREATE TABLE `widget` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);\n',
      'create table',
    )
    const { code } = runLinter(repo, 'baseline')
    expect(code).toBe(0)
  })

  it('matches case-insensitively (lowercase bare add is still flagged)', () => {
    commitFile(
      repo,
      'packages/example-db/migrations/0001_lower.sql',
      'alter table `example` add `flag` integer not null;\n',
      'lowercase bare add',
    )
    const { code, stdout } = runLinter(repo, 'baseline')
    expect(code).toBe(1)
    expect(stdout).toMatch(/NOT NULL without DEFAULT/i)
  })
})
