# Contributing

This repo follows the risk-tiered, two-gate workflow (see `CLAUDE.md` and `.dev/guide.md`).

## Tiers (classify before any work; clean tree always)
- **T0 — trivial** (typo/docs/config, no behavior change): do it → tests green → commit.
- **T1 — small feature** (one session; the default):
  short plan → 👤 **GATE 1** (approve the plan) → build with tests → `npm run gates` →
  `/review` → commit + PR. No OpenSpec, no CHANGELOG/version bump.
- **T2 — large/risky** (multi-slice; data/auth/API; hard to reverse) — the full loop:
  1. `/opsx:propose "<idea>"` — spec (proposal + WHEN/THEN scenarios + tasks).
  2. 👤 **GATE 1** — approve the plan (not the code).
  3. TDD: every scenario → a failing test (RED) first, then minimal code (GREEN).
  4. Machine gates: `npm run gates`.
  5. `/review` + `/codex` + `/cso`, then `/ship` (CHANGELOG + version here).
  6. 👤 **GATE 2** — approve go-live, then `/land-and-deploy` + `/canary`.
  7. `/opsx:archive`.

**Escalation rule:** data model / auth / security / public API / multi-session / hard to
reverse → T2. When unsure, escalate one tier. A T1 that grows mid-build re-opens GATE 1 as T2.

## Rules
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`).
- One slice = one branch = one PR. Protected `main`, no `develop`.
- Every behavior change gets a test before merge (T2: test-first, RED→GREEN).

## Test fixtures — invented data only
- Every fixture (issues, tasks, users, e-mails, URLs, tokens) is invented: `acme.atlassian.net`,
  `PROJ-*`, `jane@example.com`, `tok-123-secret`. **Never** paste real Jira exports, issue text,
  account ids or tokens into the repo — not even redacted.
- Jira is never called from tests: use `test/fixtures/fake-jira.js` (in-memory, plus a `fetch`
  emulator for the Cloud client). Backlog.md is the fake `test/fixtures/bin/backlog`, or the real
  `backlog.md` devDependency in `test/e2e.test.js`.

## Pushing and opening PRs (GitHub access)
Authenticate with the GitHub CLI — the same way for every contributor, on the host or inside the
devcontainer:

```bash
gh auth login          # browser login, or paste a fine-grained token limited to this repo
gh auth setup-git      # lets `git push` use the gh credentials
```

Prefer a fine-grained token scoped to this repository (Contents + Pull requests: read/write) over
a full-account login. Never commit tokens; `.env*` files are git-ignored and CI runs gitleaks.
