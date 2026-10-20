#!/usr/bin/env node
// Command-line entrypoint (spec: sync-cli).
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const USAGE = `Usage: jira-to-backlogmd <command> [options]

Commands:
  init      create .jira-to-backlogmd/config.json with defaults and ignore the lock file
  doctor    check the backlog CLI, the configuration and Jira access without writing
  pull      import Jira issues into Backlog.md tasks
  push      write Backlog.md status changes, links and summaries back to Jira
  sync      pull, then push, under one lock
  hook      write back one task (Backlog.md onStatusChange entrypoint; reads TASK_ID)

Options:
  --config <path>    config file (default: .jira-to-backlogmd/config.json)
  --env-file <path>  load JIRA_* variables from a dotenv file
  --dry-run          print the writes that would happen and perform none
  --verbose          add request-level detail (secrets redacted)
  -h, --help         show this help
`

export async function main(argv, { stdout = process.stdout } = {}) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    stdout.write(USAGE)
    return 0
  }
  return 1
}

// Resolve symlinks so the npm `bin` shim (a symlink) also counts as running this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
