#!/usr/bin/env bash
# check-migrations.sh — lint newly added D1 migration files for destructive SQL.
#
# Usage:
#   scripts/check-migrations.sh [BASE_REF]
#
# BASE_REF defaults to origin/main when not supplied.
# In CI the check job passes origin/${{ github.base_ref }} for PR builds.
#
# Only ADDED migration files are scanned — historical migrations are
# immutable and are never re-examined.
#
# Detected patterns (case-insensitive):
#   DROP TABLE
#   DROP COLUMN
#   ALTER TABLE ... RENAME  (RENAME TO or RENAME COLUMN)
#   ADD COLUMN ... NOT NULL  without a DEFAULT clause
#
# Any matching line fails the check (exit 1) unless it carries the
# per-line opt-out comment:
#   -- migration-lint: allow-destructive
#
# Known limitation: matching is line-by-line, so a statement wrapped across
# lines (e.g. "ALTER TABLE\n  foo RENAME ...") slips through. drizzle-kit
# emits single-line statements, which is what this guards; hand-written
# multi-line DDL still relies on PR review.
#
# Expand/contract convention: make the column nullable (or add a DEFAULT)
# in the expand migration; backfill + tighten in the contract migration
# one release later, after the old Worker isolates have drained.

set -euo pipefail

BASE_REF="${1:-origin/main}"
MIGRATION_GLOB="packages/*/migrations/*.sql"

# ── Collect newly-added migration files ──────────────────────────────────────
# git diff --name-only --diff-filter=A: only files with status A (Added)
mapfile -t ADDED_FILES < <(
  git diff --name-only --diff-filter=A "${BASE_REF}...HEAD" \
    -- "${MIGRATION_GLOB}" 2>/dev/null || true
)

if [[ ${#ADDED_FILES[@]} -eq 0 ]]; then
  echo "check-migrations: no new migration files — nothing to lint."
  exit 0
fi

echo "check-migrations: scanning ${#ADDED_FILES[@]} new migration file(s) against ${BASE_REF}..."

FINDINGS=0

for FILE in "${ADDED_FILES[@]}"; do
  LINE_NUM=0
  while IFS= read -r LINE; do
    LINE_NUM=$(( LINE_NUM + 1 ))

    # Skip lines with the explicit opt-out comment (case-insensitive).
    # Use grep -E -- to prevent the leading '--' in the pattern from being
    # interpreted as an option flag.
    if echo "$LINE" | grep -qiE -- 'migration-lint:[[:space:]]*allow-destructive'; then
      continue
    fi

    # ── Destructive pattern checks ──────────────────────────────────────────

    # DROP TABLE
    if echo "$LINE" | grep -qiE '\bDROP[[:space:]]+TABLE\b'; then
      echo "  FAIL  ${FILE}:${LINE_NUM}: DROP TABLE"
      echo "        ${LINE}"
      FINDINGS=$(( FINDINGS + 1 ))
      continue
    fi

    # DROP COLUMN
    if echo "$LINE" | grep -qiE '\bDROP[[:space:]]+COLUMN\b'; then
      echo "  FAIL  ${FILE}:${LINE_NUM}: DROP COLUMN"
      echo "        ${LINE}"
      FINDINGS=$(( FINDINGS + 1 ))
      continue
    fi

    # ALTER TABLE ... RENAME (covers RENAME TO and RENAME COLUMN)
    if echo "$LINE" | grep -qiE '\bALTER[[:space:]]+TABLE\b.*\bRENAME\b'; then
      echo "  FAIL  ${FILE}:${LINE_NUM}: ALTER TABLE ... RENAME"
      echo "        ${LINE}"
      FINDINGS=$(( FINDINGS + 1 ))
      continue
    fi

    # ADD COLUMN ... NOT NULL without a DEFAULT clause on the same line.
    # This catches the most common mistake: a bare NOT NULL column added to
    # an existing table will fail on D1 if any rows exist.
    if echo "$LINE" | grep -qiE '\bADD[[:space:]]+COLUMN\b.*\bNOT[[:space:]]+NULL\b'; then
      if ! echo "$LINE" | grep -qiE '\bDEFAULT\b'; then
        echo "  FAIL  ${FILE}:${LINE_NUM}: ADD COLUMN ... NOT NULL without DEFAULT"
        echo "        ${LINE}"
        FINDINGS=$(( FINDINGS + 1 ))
        continue
      fi
    fi

  done < "${FILE}"
done

# ── Result ───────────────────────────────────────────────────────────────────
if [[ ${FINDINGS} -gt 0 ]]; then
  echo ""
  echo "check-migrations: ${FINDINGS} destructive statement(s) found."
  echo ""
  echo "D1 migrations run BEFORE the new Worker code is deployed while old"
  echo "isolates still serve traffic. Destructive changes (DROP, RENAME,"
  echo "NOT NULL without DEFAULT) break the running app during the rollout."
  echo ""
  echo "Use the expand/contract pattern instead:"
  echo "  Expand:   add a nullable column (or one with a DEFAULT)"
  echo "  Backfill: populate existing rows in application code"
  echo "  Contract: tighten or drop the old shape in a future release"
  echo ""
  echo "If the change is intentional (e.g. brand-new table, pre-launch"
  echo "schema, or a deliberate zero-downtime squash), suppress this check"
  echo "on the specific line with:"
  echo "  -- migration-lint: allow-destructive"
  exit 1
fi

echo "check-migrations: all new migration files are safe."
