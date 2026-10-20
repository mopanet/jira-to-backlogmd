# Proposal

> Tier: **T2** — new public CLI contract, handles a write-capable Jira token, spans several
> sessions. GATE 1 (plan approval) and GATE 2 (go-live / first public release) are the user's.

## Why

Teams that run their day-to-day engineering work in [Backlog.md](https://github.com/MrLesk/Backlog.md)
still have stakeholders who live in Jira. Today there is no maintained bridge: the only prior
attempt (`eciuca/Backlog.md-jira-plugin`) stalled in October 2025, never shipped to npm, needs Bun plus
a separate MCP server, and targets a year-old Backlog.md. Upstream Backlog.md closed its Jira-sync
issue (#392) as deferred. We need a small, open-source (MIT) adapter that anyone can install from npm,
run on the machine that hosts a Backlog.md project, and that keeps Jira and Backlog.md in step without
duplicating work by hand.

## What Changes

- New npm package and CLI `jira-to-backlogmd` (Node >= 22, built-in `fetch`, minimal
  dependencies, MIT) that runs **on the same host as the Backlog.md project** and talks to Backlog.md
  only through the public `backlog` CLI (`--json` reads, `task create` / `task edit` writes).
- **Jira → Backlog.md import**: issues selected by a configurable JQL for one Jira project become
  Backlog.md tasks; re-runs update existing tasks instead of duplicating them. Content fields (title,
  description, assignee, labels, priority) and status are owned by Jira and overwrite the Backlog side;
  Backlog-owned sections (implementation plan, notes, acceptance criteria, final summary) are never
  touched by the import.
- **Backlog.md → Jira write-back**: every Backlog.md status change is transitioned on the linked Jira
  issue via a configurable two-way status mapping; URLs in the task's `references` (PR / commit links)
  become Jira remote links; the task's `finalSummary` is posted as a Jira comment when the task
  reaches Done.
- **Conflict rule**: when both sides changed status between two syncs, Backlog.md wins by default
  (`backlog-wins`), and the adapter posts an explanatory comment on the Jira issue so the override is
  never silent. `jira-wins` and `skip` are selectable.
- **Loop and race protection**: an import-triggered status write never bounces back to Jira; write-back
  is skipped when the Jira issue is already in a status mapped to the Backlog status; concurrent runs
  (scheduled timer + Backlog.md `onStatusChange` callback) are serialised by a lock.
- **Operator tooling**: `doctor` (checks `backlog` CLI version, Jira connectivity, token scopes,
  Backlog config such as `autoCommit` / `onStatusChange`), `--dry-run` on every writing command, and a
  documented systemd/cron setup.
- **Open-source packaging**: README (unofficial, not affiliated with Atlassian; supported Backlog.md
  versions; required Jira API-token scopes), SECURITY.md, `.env.example`, CONTRIBUTING; credentials
  only via environment variables; all test fixtures are invented, no real Jira data in the repo.
- Scope limits for this change (explicit non-goals): Jira Data Center / Server (the Jira client sits
  behind an interface so it can be added later), bidirectional content-field sync, Jira → Backlog
  comment sync, deleting or archiving Backlog tasks when an issue leaves the JQL scope, walking
  multi-step Jira workflow paths automatically.

## Capabilities

### New Capabilities
- `sync-config`: configuration file + environment variables — Jira connection, project key and JQL,
  two-way status mapping, assignee mapping, conflict strategy, Backlog.md project path; validation
  and defaults.
- `jira-import`: Jira → Backlog.md direction — issue selection, field mapping, ADF-to-Markdown
  conversion, create-or-update semantics, ownership boundary (what the import may and may not write).
- `jira-writeback`: Backlog.md → Jira direction — status transitions through the mapping, remote links
  from `references`, final-summary comment, conflict detection and resolution, loop guards.
- `sync-state`: the persisted link between tasks and issues and the last-synced status on both sides;
  lock file for mutual exclusion; idempotency of repeated runs.
- `sync-cli`: the command-line surface — `sync`, `pull`, `push`, `doctor`, `init`, the
  `onStatusChange` hook entrypoint, `--dry-run`, exit codes and logging with secret redaction.

### Modified Capabilities
- none (greenfield project; `openspec/specs/` is empty).

## Impact

- **Code**: new `src/` (cli, config, jira client, backlog CLI adapter, sync engine, state store,
  ADF converter) and `test/` under the existing `node:test` + Biome + gitleaks gates. A few runtime
  dependencies at most (argument parsing, YAML/JSON config); no Jira SDK, no MCP server, no database.
- **External systems**: Jira Cloud REST API v3 (search, issue, transitions, comments, remote links)
  with a scoped API token; Backlog.md >= 1.54 CLI on the host, its `onStatusChange` global config and
  (recommended) `autoCommit` setting.
- **Security**: the adapter holds a write-capable Jira token (env only; recommend a dedicated bot user
  scoped to one project). Imported Jira text lands in task files that AI agents later read — the README
  states it is untrusted content and the converter strips HTML/scripts. `/cso` runs before release.
- **Repo files**: README, SECURITY.md, CONTRIBUTING, CHANGELOG (at release), `.env.example`,
  `package.json` (`bin`, `files`, `publishConfig`), LICENSE (MIT, copyright holder `mopanet`, confirmed).
