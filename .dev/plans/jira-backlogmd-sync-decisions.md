# jira-backlogmd-sync — decisions taken during `/opsx:apply`

The user asked the agent to decide every question that came up during implementation and to
list them at the end. Each entry: the question, the options, the decision and why.

## Process and repository

1. **Unclean working tree at start** (the change folder was untracked).
   Options: stash it / commit it on a feature branch. → **Committed it as the first commit on
   `feat/jira-backlogmd-sync`** — it is the approved plan, it belongs in history.
2. **Remote already had a GitHub "Initial commit" with no common ancestor.**
   Options: force-push over it / merge with `--allow-unrelated-histories`. → **Merge**, keeping our
   README; nothing destructive.
3. **No git author identity in the container.**
   Options: global config / repo-local config. → **Repo-local**, the same identity as the existing
   scaffold commit (`mopa`).
4. **`scripts/affected-tests.mjs` ran deleted tests and skipped untracked new ones.**
   Options: work around it / fix it. → **Fixed it** in its own `fix(scripts)` commit; the dev gate
   was unusable otherwise.
5. **`node --test` default globs also run helper files under `test/fixtures/`.**
   → Narrowed the test scripts to `test/**/*.test.js`.
6. **gstack upgrade offered during `/review`.** → **Skipped** (changes outside the repo, not needed).
7. **CSO helper refused to start (`AGENTS.md` is a symlink).**
   Options: delete the symlink / mark the helper audit "not assessed" and do a manual security pass.
   → **Manual pass**; the symlink is part of the project layout.
8. **Codex sandbox cannot start in the container (no user namespaces).**
   Options: disable the sandbox / pass source and specs inline to `codex exec` read-only.
   → **Inline, read-only**.
9. **Pushing needs GitHub credentials; only another project's PAT exists in the container.**
   Options: use that PAT / ask the user for a repo-scoped PAT or `gh auth login`.
   → **Did not use the foreign PAT** (least privilege); push waits for the user.

## Design and behaviour

10. **Runtime dependencies.** Options: argument-parser + YAML libs / none. → **Zero runtime
    dependencies** (`node:util` `parseArgs`, JSON-with-comments config).
11. **Config format**: spec asks for a "commented" `config.json`. → **JSONC** (comments and trailing
    commas stripped by a small string-aware parser).
12. **Real Backlog.md in tests.** → `backlog.md@1.54.0` as a **devDependency**; the e2e test uses it
    and CI installs it with `npm ci`.
13. **Supported Backlog.md range.** → `>=1.54.0 <2` (tested 1.54.0), checked by `doctor`.
14. **Jira priority → Backlog priority.** → `Highest|High→high`, `Medium→medium`, `Low|Lowest→low`,
    anything else leaves the priority unset.
15. **Very long descriptions** (argv limit). → Truncate at **100 KB (bytes)** at a code-point
    boundary with a link to the Jira issue (first version counted characters; fixed after review).
16. **"Done" status name.** → New optional `sync.doneStatus` (default `Done`) for the summary comment.
17. **Loop-guard marker scope.** Options: only on status edits / on every adapter write. → **Every
    write** carries `JIRA_TO_BACKLOGMD_ORIGIN=import` (covers the `jira-wins` edit too).
18. **"Once per completion" summary.** → `summaryPosted` resets when the task leaves Done, so a
    reopened and re-completed task posts again.
19. **Dangling link** (task deleted locally). Options: failure (exit 3) / warning. → **Warning**,
    record skipped, run continues (spec: "skipped and reported").
20. **`--dry-run` and the lock.** Options: take the lock / do not. → **No lock** (pure read);
    documented that the plan can be stale during a real run.
21. **Fatal runtime errors** (e.g. Jira unreachable) exit code. → **3** ("run finished with
    failures"); 1 stays for usage/config/corrupt store.
22. **`doctor` for recommendations** (`autoCommit`, hook). Spec says pass/fail; design said "warn".
    → **Spec wins: FAIL with a "recommended" hint.**
23. **Secrets for the hook** (Backlog.md runs it in the user's shell). → New **`--env-file`**
    option; the environment wins over the file.
24. **Jira token type.** Options: also support scoped API tokens (gateway URL + cloudId) / classic
    token only. → **Classic token of a bot user** for now; scoped tokens documented as follow-up.
25. **Fake Jira for the hook in e2e** (hook runs in a separate process). → Local loopback HTTP
    server backed by the in-memory fake.

## Review findings (`/review` + Codex + manual `/cso`)

Fixed, each with a regression test:
- pull skipped an issue forever after a deferred conflict (timestamp shortcut);
- a Jira summary like `-h` / `--status=Done` was parsed as a `backlog` option → title after `--`;
- option-like ids and duplicate links in the state file → treated as corrupt;
- stale-lock takeover could let two runs in → takeover serialised by a second O_EXCL file and
  removal only of the exact stale content (microsecond residual window documented);
- comment/transition POSTs retried blindly after 5xx/timeouts → only 429 is retried for them;
- no request timeout, unbounded `Retry-After` → 30 s timeout, 60 s cap;
- state saved only at the end of a task's write-back → saved after every Jira write (also between
  a backlog-wins transition and its comment);
- `JIRA_BASE_URL` could be plain http → https required except loopback;
- the Jira credentials were passed to the `backlog` child process → stripped.

Not fixed, by decision:
- "unchanged issue → no write" even if a Jira-owned field was edited locally — the spec requires it;
- duplicate summary comment when Jira applied it but the response was lost — rare, at-least-once,
  documented (deduplication would need a comment search per completion);
- `stripHtml` is quadratic on adversarial input — a few hundred ms at Jira's field size limit;
- issues leaving the default JQL when closed in Jira keep their task status — spec says "left
  alone"; noted for a follow-up (e.g. reconcile linked issues outside the JQL).
