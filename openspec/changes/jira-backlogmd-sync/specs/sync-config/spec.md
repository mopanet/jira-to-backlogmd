# Spec Delta

## Purpose

Defines how an operator configures the adapter: where the Jira and Backlog.md projects are, how the
two sides' statuses and people map onto each other, and which conflict rule applies.

## ADDED Requirements

### Requirement: Configuration is loaded from a project file plus environment variables
The adapter SHALL read non-secret settings from a config file in the Backlog.md project
(`.jira-to-backlogmd/config.json` by default, overridable with `--config`) and secrets
(Jira base URL, user e-mail, API token) from environment variables only. Secrets present in the
config file SHALL be rejected.

#### Scenario: Valid file and environment
- **WHEN** the config file is valid and `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` are set
- **THEN** the adapter starts with the merged configuration

#### Scenario: Missing secret
- **WHEN** `JIRA_API_TOKEN` is not set
- **THEN** the adapter exits with a non-zero code and names the missing variable without printing any
  other secret

#### Scenario: Secret in config file
- **WHEN** the config file contains an `apiToken` (or `token`, `password`) key
- **THEN** the adapter refuses to start and explains that secrets must come from the environment

### Requirement: Jira project selection is configurable
The configuration SHALL name exactly one Jira project key and MAY provide a JQL filter. When no JQL
is given the adapter SHALL default to `project = <KEY> AND statusCategory != Done ORDER BY created ASC`.

#### Scenario: Default JQL
- **WHEN** `jira.projectKey` is `PROJ` and `jira.jql` is absent
- **THEN** the effective selection is `project = PROJ AND statusCategory != Done ORDER BY created ASC`

#### Scenario: Custom JQL outside the project
- **WHEN** `jira.jql` selects issues from another project key
- **THEN** issues whose key does not start with `<KEY>-` are ignored and a warning names them

### Requirement: Two-way status mapping
The configuration SHALL map each Backlog.md status to a non-empty, ordered list of Jira statuses.
The first entry is the write-back target; every entry is accepted on import. Each Jira status SHALL
appear under at most one Backlog.md status.

#### Scenario: Import with a secondary Jira status
- **WHEN** the mapping is `"In Progress": ["In Progress", "In Review"]` and the issue is `In Review`
- **THEN** the imported task status is `In Progress`

#### Scenario: Write-back target
- **WHEN** the mapping is `"Done": ["Done", "Closed"]` and a task becomes `Done`
- **THEN** the write-back transitions the issue to `Done`

#### Scenario: Unmapped Jira status on import
- **WHEN** an issue has a status that appears in no mapping entry
- **THEN** the issue is skipped with a warning that names the status, and other issues are processed

#### Scenario: Duplicate Jira status across entries
- **WHEN** the same Jira status appears under two Backlog.md statuses
- **THEN** configuration validation fails and names the duplicate

### Requirement: Assignee mapping
The configuration MAY map Jira account identifiers or e-mail addresses to Backlog.md assignee
strings. Unmapped Jira assignees SHALL be imported using the Jira display name.

#### Scenario: Mapped assignee
- **WHEN** `assignees` maps `jane@example.com` to `@jane` and the issue assignee is that account
- **THEN** the task assignee is `@jane`

#### Scenario: Unmapped assignee
- **WHEN** the issue assignee has no mapping entry
- **THEN** the task assignee is the Jira display name

### Requirement: Conflict strategy is configurable
The configuration SHALL accept `sync.conflictStrategy` with values `backlog-wins` (default),
`jira-wins` or `skip`.

#### Scenario: Default strategy
- **WHEN** `sync.conflictStrategy` is absent
- **THEN** the effective strategy is `backlog-wins`

#### Scenario: Unknown strategy
- **WHEN** `sync.conflictStrategy` is `latest`
- **THEN** configuration validation fails and lists the accepted values

### Requirement: Configuration validation reports all errors at once
The adapter SHALL validate the full configuration before any Jira or Backlog.md access and report
every error found in one message.

#### Scenario: Several errors
- **WHEN** `jira.projectKey` is missing and `sync.conflictStrategy` is invalid
- **THEN** one error output lists both problems and no network or CLI call is made
