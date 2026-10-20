# Spec Delta

## Purpose

The command-line surface an operator uses to set up, run, schedule and diagnose the adapter.

## ADDED Requirements

### Requirement: Commands
The CLI `jira-to-backlogmd` SHALL provide `init`, `doctor`, `pull` (Jira -> Backlog.md), `push`
(Backlog.md -> Jira), `sync` (pull then push) and `hook` (the entrypoint for Backlog.md's
`onStatusChange` callback). Every writing command SHALL accept `--dry-run`.

#### Scenario: sync order
- **WHEN** `sync` runs
- **THEN** the import completes before the write-back starts, and both use one lock acquisition

#### Scenario: Unknown command
- **WHEN** an unknown command is given
- **THEN** usage is printed and the exit code is non-zero

### Requirement: init scaffolds the configuration
`init` SHALL create the config file with commented defaults and a `.gitignore` entry for the lock
file, and SHALL NOT overwrite an existing config file.

#### Scenario: Fresh project
- **WHEN** `init` runs in a Backlog.md project without a config
- **THEN** the config file exists with the default status mapping and the lock path is ignored by git

#### Scenario: Existing config
- **WHEN** `init` runs where a config already exists
- **THEN** the file is left unchanged and the command says so

### Requirement: doctor verifies the environment without writing
`doctor` SHALL check and report, each as pass or fail: the `backlog` CLI is found and its version is
in the supported range; the Backlog.md project is initialised; the configuration is valid; Jira is
reachable and the token authenticates; the token can read the project and list transitions; the
Backlog.md `onStatusChange` hook points at this adapter; `autoCommit` is set as recommended.

#### Scenario: All checks pass
- **WHEN** every check passes
- **THEN** each check is listed as pass and the exit code is zero

#### Scenario: Token lacks write scope
- **WHEN** Jira answers the authentication check but refuses to list transitions
- **THEN** that check fails with the required scope named and the exit code is non-zero

#### Scenario: No writes
- **WHEN** `doctor` runs
- **THEN** no Jira issue, task or store file is modified

### Requirement: dry-run reports intended writes
With `--dry-run` the adapter SHALL print each write it would perform (task create/edit, transition,
remote link, comment, store update) and SHALL perform none of them.

#### Scenario: Dry pull
- **WHEN** `pull --dry-run` finds two new issues
- **THEN** two planned task creations are printed and no task or store record is created

### Requirement: hook performs a targeted write-back
`hook` SHALL read `TASK_ID`, `OLD_STATUS` and `NEW_STATUS` from the environment, run the write-back
for that task only, and exit zero without writing when the task has no linked issue or when the
change was made by the adapter's own import.

#### Scenario: Linked task
- **WHEN** `hook` runs with `TASK_ID=task-12` and the task is linked to `PROJ-7`
- **THEN** only `PROJ-7` is considered for transition

#### Scenario: Unlinked task
- **WHEN** `hook` runs for a task with no link
- **THEN** it exits zero without contacting Jira

### Requirement: Exit codes and logging
The adapter SHALL exit `0` on success, `1` on usage or configuration errors, `2` when the lock could
not be obtained and `3` when the run completed with per-item failures. Logs SHALL never contain the
API token, and `--verbose` SHALL add request-level detail with the token redacted.

#### Scenario: Partial failure
- **WHEN** a run finishes with one failed issue
- **THEN** the exit code is `3`

#### Scenario: Token never logged
- **WHEN** `--verbose` logs an HTTP request
- **THEN** the authorization value is shown as `***`
