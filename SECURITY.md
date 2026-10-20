# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/mopanet/jira-to-backlogmd/security/advisories/new)
for this repository. Do not open a public issue. Include the version, a description and, if you can,
steps to reproduce. You can expect an acknowledgement within a week.

Supported versions: the latest published release.

## Token handling

jira-to-backlogmd holds a **write-capable Jira API token**. The adapter:

- reads `JIRA_BASE_URL`, `JIRA_USER_EMAIL` and `JIRA_API_TOKEN` from the environment only (or from a
  file you name with `--env-file`) and refuses a config file that contains `token`, `apiToken`,
  `password` or `secret` keys;
- never logs the token or the `Authorization` header — they are replaced with `***`, also with
  `--verbose`, and stripped from Jira error messages;
- sends the token only to `JIRA_BASE_URL`.

What you should do:

- **Use a dedicated bot user** whose permissions are limited to the one synced project (Browse
  Projects, Transition Issues, Add Comments, Link Issues). A leaked token then exposes one project,
  not a person's whole Jira account.
- Keep the env file outside the repository with mode `600`; never commit it. `.env` files are
  git-ignored here and CI runs gitleaks on every push.
- Rotate the token when someone with access to the host leaves, and revoke it at
  <https://id.atlassian.com/manage-profile/security/api-tokens> if it may have leaked.

## Untrusted content

Imported Jira text lands in Backlog.md task files that people and AI agents read. The ADF converter
drops raw HTML, HTML comments and script content and keeps only `http(s)`/`mailto` links. The
adapter never executes imported content, and spawns `backlog` with an argument array (no shell).
Treat task descriptions imported from Jira as untrusted input.
