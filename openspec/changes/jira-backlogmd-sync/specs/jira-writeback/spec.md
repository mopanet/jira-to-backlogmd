# Spec Delta

## Purpose

Reflects work done in Backlog.md back onto the linked Jira issue: status transitions, links to the
pull requests and commits recorded on the task, and the task's final summary.

## ADDED Requirements

### Requirement: Backlog.md status changes are transitioned on the linked issue
When a linked task's status differs from the last synced Backlog.md status, the write-back SHALL
transition the Jira issue to the first Jira status mapped to the new Backlog.md status.

#### Scenario: Task moved to In Progress
- **WHEN** task `task-12` (linked to `PROJ-7`) changes from `To Do` to `In Progress`
- **THEN** `PROJ-7` is transitioned to the first Jira status mapped to `In Progress`

#### Scenario: Task completed
- **WHEN** a linked task changes to `Done`
- **THEN** the issue is transitioned to the first Jira status mapped to `Done`

### Requirement: Write-back is a no-op when Jira is already in a mapped status
The write-back SHALL NOT transition an issue whose current Jira status is any of the Jira statuses
mapped to the task's Backlog.md status.

#### Scenario: Secondary mapped status
- **WHEN** the mapping is `"In Progress": ["In Progress", "In Review"]`, the task is `In Progress`
  and the issue is `In Review`
- **THEN** no transition is requested

### Requirement: Missing direct transition is reported, not worked around
When the issue's available transitions contain no transition to the target status, the write-back
SHALL NOT perform any transition for that issue and SHALL report the issue key, current status and
target status. Other tasks in the run are unaffected.

#### Scenario: No path to Done
- **WHEN** the target status is `Done` and the issue offers transitions only to `In Progress`
- **THEN** the issue is unchanged, the error names `PROJ-7`, its status and `Done`, and the run exits
  non-zero after processing the other tasks

### Requirement: References become Jira remote links
Every `http(s)` URL in a linked task's references, other than the issue's own browse URL, SHALL be
added to the issue as a remote link. Adding the same URL again SHALL NOT create a second link.

#### Scenario: Pull request link
- **WHEN** a linked task's references contain `https://github.com/acme/app/pull/42`
- **THEN** the issue has a remote link to that URL titled with the task id and the link's host path

#### Scenario: Repeated run
- **WHEN** the write-back runs again with the same references
- **THEN** the issue still has exactly one remote link per URL

### Requirement: Final summary is posted as a comment on completion
When a linked task reaches `Done` and has a final summary, the write-back SHALL post the summary as a
Jira comment prefixed with the task id, once per completion.

#### Scenario: Completed task with summary
- **WHEN** `task-12` becomes `Done` with final summary "Replaced the token parser"
- **THEN** `PROJ-7` receives one comment containing `task-12` and "Replaced the token parser"

#### Scenario: Completed task without summary
- **WHEN** a task becomes `Done` and has no final summary
- **THEN** no comment is posted

#### Scenario: Re-run after completion
- **WHEN** the write-back runs again and the task is still `Done`
- **THEN** no additional comment is posted

### Requirement: Status conflicts follow the configured strategy
A conflict exists when, since the last sync, the Backlog.md status changed AND the Jira status
changed to a status not mapped to the new Backlog.md status. The write-back SHALL resolve it with the
configured strategy.

#### Scenario: backlog-wins
- **WHEN** strategy is `backlog-wins`, the task went `In Progress -> Done` and the issue went
  `In Progress -> Blocked`
- **THEN** the issue is transitioned to the status mapped to `Done` and receives a comment stating
  both changes and that Backlog.md took precedence

#### Scenario: jira-wins
- **WHEN** strategy is `jira-wins` in the same situation
- **THEN** the issue is not transitioned, the task status is set to the Backlog.md status mapped to
  `Blocked`, and the task's last synced statuses are updated

#### Scenario: skip
- **WHEN** strategy is `skip` in the same situation
- **THEN** neither side is changed, the conflict is reported with both statuses, and the run exits
  non-zero after the other tasks

### Requirement: Write-back failures are reported per task
A Jira error for one task SHALL be reported with the task id and issue key and SHALL NOT stop the
processing of other tasks; the run exits non-zero.

#### Scenario: Jira rejects one transition
- **WHEN** Jira returns an error for one of five transitions
- **THEN** the other four are applied, the error names the task and issue, and the exit code is
  non-zero
