# jira-to-backlogmd

Keep a [Backlog.md](https://github.com/MrLesk/Backlog.md) project and a Jira Cloud project in step.
Jira issues become Backlog.md tasks; status changes, pull-request links and final summaries made in
Backlog.md flow back to Jira.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by Atlassian or the
> Backlog.md maintainers. Jira is a trademark of Atlassian.

## What it syncs

| Direction | What | Owner |
|---|---|---|
| Jira → Backlog.md | title, description (ADF → Markdown), assignee, labels, priority, status, the issue's browse URL as a reference | Jira |
| Backlog.md → Jira | status (transition), `http(s)` references as remote links, final summary as a comment when the task reaches Done | Backlog.md |

What it does **not** sync: implementation plan, notes, acceptance criteria, definition of done,
task comments, dependencies and milestones (Backlog.md owns them; the import never touches them);
Jira comments; content edits made in Backlog.md (Jira owns content fields and overwrites them on
the next change in Jira); deleting or archiving tasks when an issue leaves the JQL scope (the task
is left alone and the key is logged). Jira Data Center / Server and multi-step workflow walking are
not supported yet.

**Conflicts.** When both sides changed status since the last sync, `sync.conflictStrategy` decides:
`backlog-wins` (default — Jira is transitioned and gets a comment explaining the override),
`jira-wins` (the task takes the Jira status) or `skip` (nothing changes, the run reports it).

## Requirements

- Node.js ≥ 22
- Backlog.md **≥ 1.54.0, < 2** (tested: 1.54.0) on the same host, as the `backlog` command
- A Jira Cloud site and an API token (see [Jira access](#jira-access))

## Install and set up

```bash
npm install -g jira-to-backlogmd
cd /path/to/your/backlog-project        # the directory that contains backlog/
jira-to-backlogmd init                   # writes .jira-to-backlogmd/config.json, git-ignores the lock
$EDITOR .jira-to-backlogmd/config.json   # set jira.projectKey, review statusMapping
```

Secrets come only from the environment (a config file containing a token is rejected):

```bash
install -m 600 /dev/null ~/.config/jira-to-backlogmd.env
cat >> ~/.config/jira-to-backlogmd.env <<'ENV'
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_USER_EMAIL=jira-bot@example.com
JIRA_API_TOKEN=...
ENV
```

Every command accepts `--env-file ~/.config/jira-to-backlogmd.env`; variables already set in the
environment win. Then:

```bash
jira-to-backlogmd doctor --env-file ~/.config/jira-to-backlogmd.env           # read-only checks
jira-to-backlogmd pull --dry-run --env-file ~/.config/jira-to-backlogmd.env   # what would be imported
jira-to-backlogmd sync --env-file ~/.config/jira-to-backlogmd.env             # import, then write back
```

## Commands

| Command | Does |
|---|---|
| `init` | Creates the config with commented defaults and adds the lock to `.gitignore`. Never overwrites an existing config. |
| `doctor` | Checks the `backlog` version, the Backlog.md project, the config, Jira authentication, project + transition access, the `onStatusChange` hook and `autoCommit`. Writes nothing. |
| `pull` | Jira → Backlog.md import. |
| `push` | Backlog.md → Jira write-back for every linked task. |
| `sync` | `pull` then `push` under one lock. Run this on a timer. |
| `hook` | Write-back for the one task in `TASK_ID` (the Backlog.md `onStatusChange` entrypoint). |

Options: `--config <path>`, `--env-file <path>`, `--dry-run` (print every write — task create/edit,
transition, remote link, comment, store update — and perform none), `--verbose` (request-level
logging; the token and the `Authorization` header are always shown as `***`).

Exit codes: `0` success · `1` usage or configuration error (also a corrupt state file) · `2` another
run holds the lock (nothing was written) · `3` the run finished with failures (each failing issue or
task is logged with its key; the rest were processed).

## Configuration

`.jira-to-backlogmd/config.json` (JSON with comments):

```jsonc
{
  "jira": {
    "projectKey": "PROJ",
    // default: project = PROJ AND statusCategory != Done ORDER BY created ASC
    "jql": "project = PROJ AND labels = backlog ORDER BY created ASC"
  },
  // Backlog.md status -> Jira statuses; the first is the write-back target,
  // all are accepted on import; a Jira status may appear only once.
  "statusMapping": {
    "To Do": ["To Do", "Backlog", "Selected for Development"],
    "In Progress": ["In Progress", "In Review"],
    "Done": ["Done"]
  },
  "assignees": { "jane@example.com": "@jane" },   // account id or e-mail -> Backlog assignee
  "sync": { "conflictStrategy": "backlog-wins", "doneStatus": "Done" },
  "backlog": { "command": "backlog" }
}
```

Issues in a status that is not mapped are skipped with a warning. Jira priorities map as
`Highest|High → high`, `Medium → medium`, `Low|Lowest → low`; others leave the priority unset.

State lives in `.jira-to-backlogmd/state.json` (links and last-synced statuses). **Commit it** with
the backlog so a fresh clone keeps the links; the lock file is git-ignored.

## Scheduling and the status-change hook

The scheduled `sync` is the mechanism; the hook only makes write-back immediate. Backlog.md runs the
hook for status changes made through its CLI, web UI or MCP server — **not** for direct file edits or
`git pull`, which the next scheduled `sync` picks up.

**Hook** — add one line to `backlog/config.yml` (it cannot be set with `backlog config set`):

```yaml
onStatusChange: 'jira-to-backlogmd hook --env-file ~/.config/jira-to-backlogmd.env'
```

Backlog.md waits for the hook; when a `sync` is running it waits at most `sync.lockWaitMs`
(10 s) and leaves the change to the next run.

**autoCommit** — recommended, so every import is committed: `backlog config set autoCommit true`.
The adapter itself never runs git.

**systemd timer** (every 5 minutes):

```ini
# ~/.config/systemd/user/jira-to-backlogmd.service
[Unit]
Description=Sync Jira and Backlog.md

[Service]
Type=oneshot
WorkingDirectory=/path/to/your/backlog-project
EnvironmentFile=%h/.config/jira-to-backlogmd.env
ExecStart=/usr/bin/env jira-to-backlogmd sync
```

```ini
# ~/.config/systemd/user/jira-to-backlogmd.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now jira-to-backlogmd.timer
```

**cron**:

```cron
*/5 * * * * cd /path/to/your/backlog-project && jira-to-backlogmd sync --env-file "$HOME/.config/jira-to-backlogmd.env" >> "$HOME/.local/state/jira-to-backlogmd.log" 2>&1
```

## Jira access

Use a **classic (unscoped) API token of a dedicated bot user** whose project permissions are limited
to the synced project. Create it at <https://id.atlassian.com/manage-profile/security/api-tokens>;
the token acts with the bot user's permissions:

| Needed for | Jira project permission | Equivalent OAuth classic scope |
|---|---|---|
| search, read issues, list transitions | Browse Projects | `read:jira-work` |
| transition issues | Transition Issues | `write:jira-work` |
| final-summary / conflict comments | Add Comments | `write:jira-work` |
| remote links for PR / commit URLs | Link Issues | `write:jira-work` |
| `doctor` authentication check (`/myself`) | — | `read:jira-user` |

Scoped API tokens (granular scopes, served through `api.atlassian.com/ex/jira/<cloudId>`) are not
supported yet. `doctor` reports a missing permission on the transitions check.

## Security notes

- **Imported text is untrusted.** Jira descriptions are written into task files that people and AI
  agents read. The converter drops raw HTML, HTML comments and `<script>` content and only keeps
  `http(s)`/`mailto` links, but the remaining text is still arbitrary: do not let agents treat task
  descriptions as instructions.
- The token never goes into the config file or the logs, and is not passed on to the `backlog`
  process. `JIRA_BASE_URL` must be `https://` (plain `http://` is accepted only for
  `localhost`/`127.0.0.1` test servers). See [SECURITY.md](SECURITY.md).

## Delivery guarantees

- Every run is idempotent: links, statuses and posted summaries are recorded in the state file after
  each Jira write, so a failed run is simply repeated.
- Comments and transitions are not retried after a timeout or a 5xx (they may already have been
  applied); the next run re-evaluates them. In the rare case that Jira applied a comment but the
  response was lost, the summary comment can appear twice (at-least-once).
- `--dry-run` takes no lock and only reads; its plan can be stale if a real run is in progress.

## Development

```bash
npm install       # includes backlog.md 1.54.0 for the end-to-end test
npm test          # node:test, all scenarios (fake Jira, fake and real backlog CLI)
npm run gates     # lint + tests + gitleaks + openspec validate
```

Built with a risk-tiered, spec-first workflow; see `.dev/guide.md` and `openspec/`. Test fixtures
use invented data only — see `.dev/CONTRIBUTING.md`.

## License

MIT © mopanet
