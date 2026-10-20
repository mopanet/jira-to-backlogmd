// The only place that talks to Backlog.md: spawns the `backlog` CLI (design D1).
import { execFile } from 'node:child_process'

export const ORIGIN_ENV = 'JIRA_TO_BACKLOGMD_ORIGIN'
const MAX_BUFFER = 64 * 1024 * 1024

export class BacklogCliError extends Error {
  constructor(message, { exitCode, args } = {}) {
    super(message)
    this.name = 'BacklogCliError'
    this.exitCode = exitCode
    this.args = args
  }
}

export class BacklogCli {
  constructor({ command = 'backlog', cwd, env = process.env, timeoutMs = 60_000 } = {}) {
    this.command = command
    this.cwd = cwd
    // The backlog CLI, and the hooks it starts for our own writes, never need Jira credentials.
    const { JIRA_API_TOKEN: _t, JIRA_USER_EMAIL: _e, ...childEnv } = env
    this.env = childEnv
    this.timeoutMs = timeoutMs
  }

  /** Run `backlog <args>` (argv array, never a shell). Writes are marked with ORIGIN_ENV. */
  run(args, { write = false } = {}) {
    const env = write ? { ...this.env, [ORIGIN_ENV]: 'import' } : this.env
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        args,
        { cwd: this.cwd, env, maxBuffer: MAX_BUFFER, timeout: this.timeoutMs },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout)
          const exitCode = typeof err.code === 'number' ? err.code : undefined
          const detail = (stderr || stdout || err.message).trim()
          reject(
            new BacklogCliError(`backlog ${args.slice(0, 2).join(' ')} failed: ${detail}`, {
              exitCode,
              args,
            }),
          )
        },
      )
    })
  }

  async json(args, kind) {
    const out = await this.run(args)
    let data
    try {
      data = JSON.parse(out)
    } catch {
      throw new BacklogCliError(`backlog ${args.join(' ')} did not print JSON`, { args })
    }
    if (data?.schemaVersion !== 1 || data.kind !== kind) {
      throw new BacklogCliError(
        `backlog ${args.join(' ')} printed unsupported JSON (schemaVersion ${data?.schemaVersion}, kind ${data?.kind}); expected ${kind} v1`,
        { args },
      )
    }
    return data
  }

  async version() {
    return (await this.run(['--version'])).trim()
  }

  async configGet(key) {
    return (await this.run(['config', 'get', key])).trim()
  }

  async listTasks() {
    return (await this.json(['task', 'list', '--json'], 'task-list')).tasks
  }

  /** The full task (incl. archived ones), or null when Backlog.md does not know the id. */
  async viewTask(id) {
    try {
      return (await this.json(['task', 'view', id, '--json'], 'task-view')).task
    } catch (e) {
      if (e instanceof BacklogCliError && /not found/i.test(e.message)) return null
      throw e
    }
  }

  async createTask({ title, description, status, assignees, labels, priority, references }) {
    const args = ['task', 'create']
    if (description) args.push('--description', description)
    if (status) args.push('--status', status)
    args.push('--assignee', (assignees ?? []).join(','))
    if (labels?.length) args.push('--labels', labels.join(','))
    if (priority) args.push('--priority', priority)
    for (const ref of references ?? []) args.push('--ref', ref)
    // "--" so a Jira summary such as "-h" or "--status=Done" is taken literally.
    args.push('--plain', '--', title)
    const out = await this.run(args, { write: true })
    const m = out.match(/^Task (\S+) - /m)
    if (!m)
      throw new BacklogCliError('backlog task create did not report the new task id', { args })
    return m[1]
  }

  /** Apply only the given keys; `[]` clears labels/assignees. */
  async editTask(id, changes) {
    const args = ['task', 'edit', id]
    const { title, description, status, assignees, labels, priority, addReferences } = changes
    if (title !== undefined) args.push('--title', title)
    if (description !== undefined) args.push('--description', description)
    if (status !== undefined) args.push('--status', status)
    if (assignees !== undefined) args.push('--assignee', assignees.join(','))
    if (labels !== undefined) {
      if (labels.length) args.push('--label', labels.join(','))
      else args.push('--clear-labels')
    }
    if (priority !== undefined) args.push('--priority', priority)
    for (const ref of addReferences ?? []) args.push('--add-ref', ref)
    args.push('--plain')
    await this.run(args, { write: true })
  }
}
