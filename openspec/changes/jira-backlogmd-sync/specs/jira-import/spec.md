# Spec Delta

## Purpose

Brings Jira issues into a Backlog.md project as tasks and keeps the Jira-owned fields of those tasks
up to date on every run, without touching the parts of a task that Backlog.md users and agents own.

## ADDED Requirements

### Requirement: Selected issues become Backlog.md tasks
For every Jira issue matched by the configured selection that has no linked task, the import SHALL
create a Backlog.md task through the Backlog.md CLI and record the link in the sync state.

#### Scenario: New issue
- **WHEN** issue `PROJ-7` matches the selection and no task is linked to it
- **THEN** a task is created with the issue's title and the link `PROJ-7 -> <task-id>` is recorded

#### Scenario: Re-run does not duplicate
- **WHEN** the import runs twice with the same selection
- **THEN** the second run creates no new task for an issue that already has a linked task

### Requirement: Jira-owned fields are imported
The import SHALL write exactly these task fields from the issue: title, description, assignee,
labels, priority and status (through the status mapping). It SHALL also add the issue's browse URL to
the task's references when absent.

#### Scenario: Field mapping
- **WHEN** issue `PROJ-7` has summary "Fix login", labels `auth`, priority `High`, status `To Do`
- **THEN** the task has title "Fix login", label `auth`, priority `high`, status `To Do` and a
  reference `https://<jira>/browse/PROJ-7`

#### Scenario: Changed Jira field is re-applied
- **WHEN** the issue summary changed in Jira since the last run
- **THEN** the linked task's title is updated to the new summary

### Requirement: Backlog-owned sections are never written by the import
The import SHALL NOT modify a task's implementation plan, implementation notes, acceptance criteria,
definition of done, comments, final summary, dependencies, milestone or any reference that it did not
add itself.

#### Scenario: Task with local work
- **WHEN** a linked task has an implementation plan and two checked acceptance criteria
- **THEN** after an import run the plan and criteria are byte-for-byte unchanged

#### Scenario: Unchanged issue
- **WHEN** no Jira-owned field of an issue changed since the last run
- **THEN** the import issues no write for that task

### Requirement: Jira descriptions are converted to Markdown
Issue descriptions in Atlassian Document Format SHALL be converted to Markdown preserving
paragraphs, headings, ordered and unordered lists, code blocks, inline code, bold, italic and links.
Unsupported nodes SHALL degrade to their plain text. Raw HTML and script content SHALL be dropped.

#### Scenario: Common nodes
- **WHEN** the description contains a heading, a bullet list and a fenced code block
- **THEN** the task description contains the equivalent Markdown constructs

#### Scenario: Unsupported node
- **WHEN** the description contains a node type the converter does not know
- **THEN** the node's text content is emitted and the run continues

#### Scenario: HTML in description
- **WHEN** the description text contains `<script>` or other HTML tags
- **THEN** the tags are not present in the task description

### Requirement: Import-driven status changes do not trigger write-back
When the import changes a task's status, the resulting Backlog.md status-change callback SHALL NOT
cause a write-back to Jira for that change.

#### Scenario: Status pulled from Jira
- **WHEN** the import moves a task from `To Do` to `In Progress` because the issue changed in Jira
- **THEN** no transition request is sent to Jira as a result of that change

### Requirement: Issues leaving the selection are left alone
An issue that no longer matches the selection, or that no longer exists in Jira, SHALL leave its
linked task untouched; the run SHALL log the issue key.

#### Scenario: Issue moved out of scope
- **WHEN** a previously imported issue no longer matches the selection
- **THEN** the linked task keeps its current content and status, and the key appears in the log

### Requirement: Per-issue failures do not abort the run
A failure while importing one issue SHALL be reported with the issue key and the run SHALL continue
with the remaining issues, exiting non-zero at the end.

#### Scenario: One malformed issue
- **WHEN** one of ten issues cannot be written to Backlog.md
- **THEN** the other nine are imported, the error names the failing key, and the exit code is non-zero
