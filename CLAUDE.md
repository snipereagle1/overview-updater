# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the weekly SDE check (requires GITHUB_TOKEN, GITHUB_REPOSITORY env vars for real run)
pnpm run check-sde

# Dry run — prints results and PR body without writing files or creating a PR
pnpm exec tsx scripts/check-sde.ts --dry-run

# Force a full check even if build number is unchanged
pnpm exec tsx scripts/check-sde.ts --force

# Validate all overview YAMLs against the live SDE
pnpm run validate

# Run any script directly
pnpm exec tsx scripts/<script>.ts
```

## Architecture

This is an automated EVE Online overview YAML maintenance tool. It runs weekly via GitHub Actions.

### Data flow

1. **`sde-client.ts`** — shared module. Fetches the current SDE build number from EVE's API, downloads `groups.jsonl` from the SDE zip, and provides an in-memory `Map<groupId, Group>`. Caches the groups map in `sde-state/groups-cache.json` keyed by build number (local dev only, gitignored).

2. **`check-sde.ts`** — weekly automation entry point. Compares the live build number against `sde-state/sde-build.txt`. If changed (or `--force`), it processes all `overviews/*.yaml` files:
   - Strips stale group IDs (IDs no longer present in the SDE at all) using surgical text editing
   - Detects new groups in watched categories not yet referenced in any overview
   - Creates a GitHub PR via `@octokit/rest` using the Git Trees API (no local git)

3. **`validate.ts`** — CI check. Parses all overview YAMLs, extracts group IDs, and fails if any ID is missing from the SDE. Note: `published: false` is allowed (celestials like Sun/Stargate/Station are unpublished market-wise but real in-game objects).

4. **`yaml-edit.ts`** — surgical line-level YAML editor. Operates on raw text without parse/dump to preserve formatting. Provides `removeGroupIds()` and `addGroupId()`. The EVE YAML groups block uses a specific structure: `- - groups` header, then `- - <firstId>` followed by `- <id>` for subsequent items.

5. **`pr-command.ts`** — processes `/add-group` commands from PR comments. Triggered by the `pr-command.yml` workflow when a collaborator comments on a PR. Supports three modes:
   - `/add-group <id> to "<preset name pattern>"` — fuzzy preset name match
   - `/add-group <id> like <existingId>` — copy to same presets as an existing group
   - `/add-group <id> to all-ships|all-npcs|all-drones|all-deployables|all-structures`

6. **`category-config.ts`** — human-editable list of SDE category IDs to watch for new groups (Ships, NPCs, Drones, Deployables, Structures).

### GitHub Actions workflows

- **`sde-check.yml`** — runs `check-sde.ts` every Monday at 10:00 UTC and on `workflow_dispatch`
- **`validate.yml`** — runs `validate.ts` on push/PR to main
- **`pr-command.yml`** — triggered by PR comments containing `/add-group`; checks commenter permissions (write/admin/maintain), checks out the PR branch, runs `pr-command.ts`, then commits and pushes changes

### YAML preservation strategy

EVE overview YAML has a nested sequence-of-pairs structure (`presets[n][0]` = name, `presets[n][1]` = array of `[key, value]` pairs). To avoid reformatting the entire file on every run, `yaml-edit.ts` performs surgical text-level edits rather than parse-and-dump. The `dumpYaml()` helper in `sde-client.ts` is available for cases where a full re-dump is acceptable.

### Key env vars (required in CI/production)

| Variable | Used by |
|----------|---------|
| `GITHUB_TOKEN` | `check-sde.ts`, `pr-command.ts` |
| `GITHUB_REPOSITORY` | `check-sde.ts`, `pr-command.ts` (format: `owner/repo`) |
| `COMMENT_BODY` | `pr-command.ts` |
| `PR_NUMBER` | `pr-command.ts` |
