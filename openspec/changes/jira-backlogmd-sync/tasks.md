# Tasks

> TDD is mandatory (T2): every `#### Scenario:` in `specs/` gets a failing test before the code that
> makes it pass. Fixtures are invented data only. Iterate with `npm run gates:dev`; the full
> `npm run gates` runs once before each merge into `main`.

## 1. Spikes (throwaway, findings recorded in design.md)

- [x] 1.1 Install Backlog.md on the devcontainer, create a scratch project and verify which actions fire the global `onStatusChange` callback (CLI edit, web UI, MCP, direct file edit, `git pull`) and whether the callback inherits the parent's environment; record the matrix in design.md Risks
- [x] 1.2 Verify `backlog task edit` with a 20 KB multi-line Markdown description containing quotes, `#`, `:` and backticks round-trips through `task view --json`; record the safe argv form or the fallback in design.md D1
- [x] 1.3 Verify where a `Done` task lives after completion/archiving (`backlog/tasks`, `completed`, `archive`) and that `task view <id> --json` still resolves it; record the behaviour and the pinned Backlog.md version in design.md
- [x] 1.4 Verify whether `task edit` preserves unknown frontmatter keys and whether `references` can be appended via the CLI; record in design.md D3

## 2. Scaffolding and configuration (spec: sync-config)

- [x] 2.1 Add `bin`, `files`, `engines`, `publishConfig` to package.json, create `src/cli.js` printing usage, and verify `node src/cli.js --help` exits 0 and `npm run gates:dev` passes
- [x] 2.2 Write failing tests for every `sync-config` scenario (file + env loading, secret rejection, default JQL, status-mapping validation incl. duplicate detection, assignee mapping, conflict strategy, aggregated errors), then implement `src/config.js` until they pass
- [x] 2.3 Add `.env.example` and a commented default `config.json` template used by `init`, and verify the template loads through `config.js` with zero validation errors

## 3. Logging and Backlog.md CLI adapter

- [x] 3.1 Write failing tests for `src/log.js` redaction (token value and `Authorization` header shown as `***`, `--verbose` levels), then implement until they pass
- [x] 3.2 Write failing tests for `src/backlog-cli.js` against a fake `backlog` executable in `test/fixtures/bin` (list/view JSON parsing, create/edit argv construction without a shell, non-zero exit handling, `JIRA_TO_BACKLOGMD_ORIGIN` passed to children), then implement until they pass

## 4. State store and lock (spec: sync-state)

- [x] 4.1 Write failing tests for every `sync-state` scenario (record after import, fresh checkout, atomic write via temp+rename, corrupt store, lock contention, stale lock takeover, dangling link reporting), then implement `src/state.js` until they pass

## 5. Jira client and ADF converter

- [x] 5.1 Write failing tests for `src/jira/adf.js` from fixtures covering every node type named in the `jira-import` description scenarios plus unknown nodes and embedded HTML, then implement the renderer until they pass
- [ ] 5.2 Write failing tests for the Cloud `JiraClient` request builder (basic-auth header, `search/jql` pagination, transitions lookup, comment body in ADF, remote link with `globalId`, 429 backoff honouring `Retry-After`, 5xx retry limit) using an injected fake `fetch`, then implement `src/jira/client.js` until they pass
- [ ] 5.3 Implement the in-memory `FakeJiraClient` used by the sync tests and verify it satisfies the same interface tests as the Cloud client

## 6. Import: Jira -> Backlog.md (spec: jira-import)

- [ ] 6.1 Write failing tests for every `jira-import` scenario (create, no-duplicate re-run, field mapping incl. browse-URL reference, changed-field re-apply, Backlog-owned sections untouched, no write when unchanged, origin marker on status edits, out-of-scope issue left alone, per-issue failure isolation) using `FakeJiraClient` and the fake `backlog`, then implement `src/sync/pull.js` until they pass
- [ ] 6.2 Wire `pull` and `pull --dry-run` into `src/cli.js` and verify the `sync-cli` "Dry pull" scenario test passes

## 7. Write-back: Backlog.md -> Jira (spec: jira-writeback)

- [ ] 7.1 Write failing tests for the status scenarios (transition on change, completion, no-op on mapped status, missing direct transition reported) then implement the status part of `src/sync/push.js` until they pass
- [ ] 7.2 Write failing tests for remote links (PR link, repeated run idempotent, own browse URL excluded) and the final-summary comment (posted once, none without summary, no repeat on re-run), then implement until they pass
- [ ] 7.3 Write failing tests for conflict detection and the three strategies (`backlog-wins` with explanatory comment, `jira-wins`, `skip`) plus per-task failure isolation, then implement until they pass
- [ ] 7.4 Wire `push`, `sync` (pull then push under one lock) and `hook` (targeted write-back, exit 0 on unlinked task or import origin) into `src/cli.js` and verify the corresponding `sync-cli` scenario tests pass

## 8. Operator commands (spec: sync-cli)

- [ ] 8.1 Write failing tests for `init` (fresh project scaffold incl. `.gitignore` entry, existing config untouched) then implement until they pass
- [ ] 8.2 Write failing tests for `doctor` (each check pass/fail, scope failure names the scope, no writes) with fakes, then implement until they pass; confirm and record the minimum Jira Cloud token scopes in README and design.md
- [ ] 8.3 Write failing tests for exit codes (`0/1/2/3`) and unknown-command usage, then implement until they pass

## 9. Documentation and packaging

- [ ] 9.1 Write README.md: what it does and does not sync, install, `init`/`doctor`/`pull`/`push`/`sync`, systemd timer + cron examples, `onStatusChange` and `autoCommit` setup, supported Backlog.md versions, token scopes, "unofficial / not affiliated with Atlassian" and "imported text is untrusted" notices; verify every documented command runs as written against the fake backlog
- [ ] 9.2 Write SECURITY.md (reporting, token handling, bot-user recommendation) and update `.dev/CONTRIBUTING.md` with the fixture rule (invented data only); verify gitleaks passes on the tree
- [ ] 9.3 Keep the LICENSE copyright holder as `mopanet` (confirmed by the user) and verify `npm pack --dry-run` lists only `src/`, `README.md`, `LICENSE`, `SECURITY.md`, `package.json`

## 10. Integration

- [ ] 10.1 End-to-end test: `sync` over a fixture Jira (fake client) and a scratch Backlog.md project created with the real `backlog` CLI, covering import -> local status change -> hook write-back -> conflict, and verify it passes in `npm run gates`
- [ ] 10.2 Run the full `npm run gates`, `/review`, `/codex` and `/cso`; fix findings (max 3 rounds); verify all green before the merge into `main`

## Workflow follow-up

- GATE 2: user approves the first public GitHub push and npm publish (`/ship` for CHANGELOG + version).
- Archive the change with `/opsx:archive` after release.
