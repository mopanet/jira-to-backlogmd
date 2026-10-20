# Spec Delta

## Purpose

Keeps the durable record that makes repeated runs safe: which task is linked to which issue, what
each side looked like at the last sync, and a lock that prevents two runs from overlapping.

## ADDED Requirements

### Requirement: Links and last-synced statuses are persisted in the Backlog.md project
The adapter SHALL persist, inside the Backlog.md project directory, one record per link holding the
task id, the issue key, the last synced Backlog.md status, the last synced Jira status, the issue's
last seen Jira `updated` timestamp, the set of reference URLs already linked, and whether the final
summary has been posted. The store SHALL be human-readable text.

#### Scenario: Record after import
- **WHEN** `PROJ-7` is imported as `task-12` with status `To Do`
- **THEN** the store holds a record `task-12 <-> PROJ-7` with both last synced statuses `To Do`

#### Scenario: Store survives a fresh checkout
- **WHEN** the Backlog.md project is cloned to another path with the store file included
- **THEN** a run there recognises every existing link and creates no duplicates

### Requirement: Store writes are atomic
The store SHALL be written so that an interrupted run leaves either the previous or the new complete
content, never a partial file.

#### Scenario: Interrupted write
- **WHEN** the process is killed while the store is being written
- **THEN** the next run loads a complete, valid store

### Requirement: A corrupt store stops the run
If the store cannot be parsed, the adapter SHALL exit non-zero before any Jira or Backlog.md write
and name the file.

#### Scenario: Truncated store
- **WHEN** the store file contains invalid content
- **THEN** no write occurs and the error names the store path

### Requirement: Concurrent runs are serialised
The adapter SHALL hold an exclusive lock for the duration of a run. A second run that cannot obtain
the lock within a short wait SHALL exit without writing anything and say which process holds the lock.

#### Scenario: Timer and callback overlap
- **WHEN** a scheduled run is in progress and the status-change hook starts another run
- **THEN** the second run waits briefly, then exits non-zero without touching Jira or Backlog.md

#### Scenario: Stale lock
- **WHEN** a lock file exists but its owning process is no longer running
- **THEN** the new run takes over the lock and proceeds

### Requirement: Dangling links are reported
A record whose task no longer exists in the Backlog.md project SHALL be skipped and reported with the
task id and issue key.

#### Scenario: Task deleted locally
- **WHEN** the store links `task-12` to `PROJ-7` and `task-12` does not exist
- **THEN** the run reports the dangling link and processes the remaining records
