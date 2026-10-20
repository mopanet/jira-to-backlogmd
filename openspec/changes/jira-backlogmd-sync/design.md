# Design

## Context

Greenfield Node >= 22 project (`node:test`, Biome, gitleaks, `npm run gates`). See proposal.md for
motivation. Constraints that shape the approach:

- Backlog.md (>= 1.54, a Bun binary installed on the host) exposes a **stable, versioned JSON read
  API** on the CLI (`task list --json`, `task view --json`) and write commands (`task create`,
  `task edit`); its web server binds to `127.0.0.1` without auth and its HTTP routes are internal.
- Backlog.md runs a global `onStatusChange` shell callback on status changes made through its own
  commands (CLI / web / MCP), passing `TASK_ID`, `OLD_STATUS`, `NEW_STATUS`, `TASK_TITLE`.
- Jira Cloud REST v3: `search/jql` (the classic `search` endpoint is deprecated), issue, transitions,
  comments (ADF body), remote links (idempotent via `globalId`). Descriptions arrive as ADF JSON.
- The adapter runs unattended on the host next to the Backlog.md repo (timer + callback).

## Goals / Non-Goals

**Goals:**
- Zero coupling to Backlog.md internals: only the `backlog` CLI, only documented flags and the JSON
  output. One place (`BacklogCli`) to adapt when the CLI changes.
- Every run idempotent and resumable; nothing is lost silently (every override leaves a trace).
- Small dependency surface for a tool that holds a write-capable token.

**Non-Goals:**
- Real-time sync via Jira webhooks (would need an inbound port on the host).
- A persistence-layer plugin inside Backlog.md (upstream has announced but not shipped one).
- Jira Data Center in this change — kept possible by the `JiraClient` interface.

## Decisions

### D1. Backlog.md access through the CLI, not files or HTTP
Writes go through `backlog task create|edit` spawned with an argv array (no shell), reads through
`--json`. Alternatives: editing task files directly (fast, but breaks on every frontmatter change and
bypasses `onStatusChange`/`autoCommit`); the web server's `/api/*` (undocumented, localhost-only, no
auth). The CLI is the only surface the maintainers call stable.

*Spike 1.2 (Backlog.md 1.54.0):* a 20 KB multi-line Markdown description with quotes, `#`, `:`,
backticks, fenced code and `---` lines passed as a single argv element
(`task edit <id> --description <text>`, `spawn` without a shell) round-trips through
`task view --json` byte-for-byte except for leading/trailing whitespace (Backlog.md trims). No
fallback is needed; the adapter compares descriptions after `trim()`. A description that itself
contains `## Implementation Plan` / `<!-- SECTION:… -->` lines does not leak into other sections
(sections are delimited by HTML-comment markers), and the ADF converter drops HTML comments anyway.
`task create` has no `--json`; the new id is parsed from the `Task <ID> - <title>` line of
`--plain` output. Ids are upper-case (`TASK-1`) and lookups are case-insensitive.

### D2. Ownership split instead of three-way merge
Jira owns content fields and is the source for status on import; Backlog.md owns plan/notes/AC/
summary and is the source for status on write-back. Conflicts are therefore confined to *status*,
which keeps the state model to "last synced status per side". A full field-level three-way merge
(the approach of the stalled prior plugin) was rejected as the main reason that project did not land.

### D3. State in a JSON file inside the Backlog.md project, not frontmatter
`.jira-to-backlogmd/state.json` holds the links and last-synced data; it is committed with the
backlog so a fresh clone keeps the links (the lock file is gitignored). Alternatives: custom
frontmatter keys (unverified whether Backlog.md 1.54 preserves unknown keys on `task edit`);
SQLite (a native dependency for a few hundred rows). The Jira browse URL is additionally written to
the task's `references` so humans see the link in the task itself.

*Spike 1.4 (Backlog.md 1.54.0):* `task edit` **drops** unknown frontmatter keys (a hand-added
`jira_key:` vanished on the next edit — the serializer writes only known fields), which confirms
the separate state file. `references` can be appended without touching others via
`task edit <id> --add-ref <url>`; `task list --json` returns `references` but not description or
final summary, so the adapter reads those with `task view --json` per task.

### D4. Loop guard via an environment marker
The import runs `backlog task edit -s ...` with `JIRA_TO_BACKLOGMD_ORIGIN=import` in the child's
environment; the `hook` command inherits it from Backlog.md's callback and exits immediately when it
is set. Second guard, independent of the first: write-back never transitions when the issue is
already in a status mapped to the task's status (spec `jira-writeback`). Both are needed: the env
marker is lost if the callback is not inherited; the mapped-status check alone does not cover
`jira-wins` resolutions.

### D5. Lock: a lock file with PID + timestamp, `O_EXCL` create, 10 s wait, stale takeover
Simple, portable, no extra dependency. Stale = PID not alive (`process.kill(pid, 0)` throws) or
older than a configurable max run age. Alternative `flock` is not available on all platforms Node
runs on.

### D6. Direct transition only; no automatic workflow walking
If `GET /issue/{key}/transitions` has no transition whose target status equals the mapped Jira status,
the item fails with a clear message. Walking intermediate transitions could trigger validators, screens
with required fields and post-functions the operator did not intend. A future `transitionPath` config
can add explicit multi-step paths.

### D7. Remote links keyed by `globalId = jira-to-backlogmd:<task-id>:<sha1(url)>`
Jira treats a remote link POST with an existing `globalId` as an update, which gives idempotency
without a prior GET. The state also records linked URLs so a dry-run can report accurately.

### D8. Conflict detection uses last-synced statuses, not timestamps
Conflict = `task.status != state.lastBacklogStatus` AND `issue.status not in mapping[task.status]`
AND `issue.status != state.lastJiraStatus`. Timestamps are not used: Backlog.md's `updatedDate`
moves on any field edit and the clocks of Jira and the host are unrelated.

### D9. ADF -> Markdown converter written in-house
A small recursive renderer covering the node types listed in the spec; everything else falls back to
text. Alternatives: `adf-to-md` style packages (unmaintained, pull in large dependency trees). The
converter is pure and fixture-tested.

### D10. Jira client behind an interface, Cloud implementation first
`JiraClient { searchIssues, getIssue, getTransitions, transition, addComment, addRemoteLink,
myself }`. The Cloud implementation uses basic auth (e-mail + API token) over `fetch`, retries on
429/5xx with exponential backoff and honours `Retry-After`. Tests use an in-memory fake; HTTP shape
is covered by fixture-based tests of the request builder, never by calling a real Jira.

### D11. Module layout
```
src/
  cli.js            command parsing, exit codes
  config.js         load + validate (sync-config)
  state.js          state store + lock (sync-state)
  backlog-cli.js    BacklogCli: spawn `backlog`, parse --json
  jira/client.js    JiraClient interface + Cloud impl
  jira/adf.js       ADF -> Markdown
  sync/pull.js      jira-import
  sync/push.js      jira-writeback (status, links, summary, conflicts)
  log.js            logger with redaction
test/               one file per module, fixtures under test/fixtures (invented data only)
```
Plain ESM JavaScript with JSDoc types to stay on the repo's existing `node:test`/Biome setup with no
build step; `tsc --noEmit` over JSDoc can be added later if wanted.

## Spike findings: Backlog.md 1.54.0 (pinned, tested version)

**`onStatusChange` matrix (spike 1.1).** The key is a top-level `onStatusChange:` line in
`backlog/config.yml` (not settable through `backlog config set`; a per-task frontmatter override
also exists). Backlog.md runs it as `sh -c <command>` with `cwd` = project root and
`env = {...process.env, TASK_ID, OLD_STATUS, NEW_STATUS, TASK_TITLE}`, and **awaits** it.

| Action | Fires callback | Parent env inherited |
|---|---|---|
| `backlog task edit -s` (CLI) | yes (verified) | yes (verified: `JIRA_TO_BACKLOGMD_ORIGIN=import` arrived) |
| web UI / MCP | yes — same `Core.executeStatusChangeCallback` path (code-inspected, not exercised) | env of the server process |
| `backlog task create -s` | no status *change*, no callback | — |
| direct file edit | no (verified) | — |
| `git pull` | no (it is a file change) | — |

Because the callback is awaited, a hook that waits on the lock delays the user's `backlog` command
by at most the lock wait (10 s); the scheduled `sync` remains the safety net.

**Done / archive (spike 1.3).** A task set to `Done` stays in `backlog/tasks/`. `task archive`
moves it to `backlog/archive/tasks/`; `task view <id> --json` still resolves it (`archived: true`)
but `task list --json` omits it. The adapter therefore resolves linked tasks with `task view`, never
by presence in `task list`. A missing task makes `task view` exit 1 with `Task <ID> not found`, which
the adapter maps to a dangling link.

**Priorities.** Backlog.md 1.54 configures `High, Medium, Low` and stores them lower-case. Jira's
default scheme is mapped `Highest|High -> high`, `Medium -> medium`, `Low|Lowest -> low`; any other
Jira priority leaves the task priority unset.

## Risks / Trade-offs

- [Backlog.md CLI flag or JSON shape changes between releases] → single adapter module; `doctor`
  checks the version against a tested range; CI matrix can install pinned Backlog.md versions later.
- [`onStatusChange` not fired for file edits / `git pull`] → the scheduled `sync` is the safety net;
  README states the callback is an accelerator, not the mechanism.
- [Callback env not inherited by Backlog.md's spawn] → verified inherited in 1.54.0; the second loop
  guard (mapped-status check) still prevents bounces if a future version changes that.
- [`task edit` with long multi-line descriptions hits argv limits or YAML quoting bugs] → verified
  safe at 20 KB in 1.54.0. Descriptions above 100 KB are truncated with a notice pointing at the Jira
  issue, well below Linux's 128 KB single-argument limit.
- [Jira transition requires fields (resolution, screens)] → fail loudly with the Jira error body;
  documented; `transitionPath`/`transitionFields` left for a follow-up change.
- [Write-capable token on the host] → env-only, SECURITY.md, bot-user recommendation, scopes listed,
  redaction tested, gitleaks in CI.
- [Untrusted Jira text read by AI agents in the Backlog] → README warning; converter strips HTML;
  no execution of imported content anywhere in the adapter.
- [`autoCommit` off leaves a dirty backlog repo after each sync] → `doctor` warns; README recommends
  the setting; the adapter itself never runs git.

## Migration Plan

Greenfield; no migration. Rollout on the operator's host: `npm i -g jira-to-backlogmd` →
`jira-to-backlogmd init` → set env → `doctor` → `pull --dry-run` → `pull` → install the timer and set
`onStatusChange: "jira-to-backlogmd hook"` in the Backlog.md config. Rollback: remove the timer and the
callback line; the state file can be deleted, tasks remain valid Backlog.md tasks.

## Open Questions

- Which Jira API-token scopes are the exact minimum for Cloud (classic vs granular scopes differ);
  confirmed during the `doctor` task against the Atlassian docs and recorded in the README.
- ~~Supported Backlog.md version range~~ — resolved: `>=1.54.0 <2` (tested 1.54.0); `doctor` checks it.
