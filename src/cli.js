#!/usr/bin/env node
// Command-line entrypoint (spec: sync-cli).
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { BacklogCli, ORIGIN_ENV } from './backlog-cli.js'
import { ConfigError, loadConfig } from './config.js'
import { runDoctor } from './doctor.js'
import { runInit } from './init.js'
import { JiraCloudClient } from './jira/client.js'
import { createLogger } from './log.js'
import { acquireLock, LockError, loadState, StateError } from './state.js'
import { pull } from './sync/pull.js'
import { push } from './sync/push.js'

export const EXIT = { OK: 0, USAGE: 1, LOCKED: 2, FAILED: 3 }
const COMMANDS = ['init', 'doctor', 'pull', 'push', 'sync', 'hook']

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
  --env-file <path>  load JIRA_* variables from a dotenv file (the environment wins)
  --dry-run          print the writes that would happen and perform none
  --verbose          add request-level detail (secrets redacted)
  -h, --help         show this help

Exit codes: 0 success, 1 usage or configuration error, 2 lock held by another run,
3 run finished with failures.
`

const defaultJira = (config, logger) =>
  new JiraCloudClient({
    baseUrl: config.jira.baseUrl,
    email: config.jira.email,
    token: config.jira.token,
    logger,
  })

const defaultBacklog = (config, env) =>
  new BacklogCli({ command: config.backlog.command, cwd: config.backlog.projectDir, env })

/** Run the CLI; returns the exit code. Dependencies are injectable for tests. */
export async function main(
  argv,
  {
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    createJira = defaultJira,
    createBacklog = defaultBacklog,
  } = {},
) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'env-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (e) {
    stderr.write(`error: ${e.message}\n\n${USAGE}`)
    return EXIT.USAGE
  }
  const { values: opts, positionals } = parsed
  const [command, ...extra] = positionals
  if (opts.help || !command) {
    ;(command || opts.help ? stdout : stderr).write(USAGE)
    return opts.help ? EXIT.OK : EXIT.USAGE
  }
  if (!COMMANDS.includes(command) || extra.length) {
    stderr.write(`error: unknown command "${positionals.join(' ')}"\n\n${USAGE}`)
    return EXIT.USAGE
  }

  // The adapter's own Backlog.md writes re-enter here through onStatusChange: stop first.
  if (command === 'hook' && env[ORIGIN_ENV]) return EXIT.OK

  let log = createLogger({ verbose: opts.verbose, stdout, stderr })
  if (command === 'init') return runInit({ projectDir: cwd, configPath: opts.config, log })

  let runEnv = env
  if (opts['env-file']) {
    try {
      const fromFile = parseEnv(readFileSync(opts['env-file'], 'utf8'))
      runEnv = { ...env }
      for (const [k, v] of Object.entries(fromFile)) if (!runEnv[k]) runEnv[k] = v
    } catch (e) {
      log.error(`cannot read --env-file: ${e.message}`)
      return EXIT.USAGE
    }
  }
  log = createLogger({
    verbose: opts.verbose,
    secrets: [runEnv.JIRA_API_TOKEN],
    stdout,
    stderr,
  })

  if (command === 'doctor') {
    const ok = await runDoctor({
      projectDir: cwd,
      configPath: opts.config,
      env: runEnv,
      log,
      createJira,
      createBacklog,
    })
    return ok ? EXIT.OK : EXIT.FAILED
  }

  const taskId = command === 'hook' ? runEnv.TASK_ID : undefined
  if (command === 'hook' && !taskId) {
    log.error('hook needs TASK_ID in the environment (set by Backlog.md onStatusChange)')
    return EXIT.USAGE
  }

  let config
  let state
  try {
    config = loadConfig({ projectDir: cwd, configPath: opts.config, env: runEnv })
    state = loadState(config.backlog.projectDir)
  } catch (e) {
    if (e instanceof ConfigError || e instanceof StateError) {
      log.error(e.message)
      return EXIT.USAGE
    }
    throw e
  }

  if (command === 'hook') {
    if (!state.byTask(taskId)) {
      log.debug(`hook: ${taskId} is not linked to a Jira issue; nothing to do`)
      return EXIT.OK
    }
    log.debug(`hook: ${taskId} "${runEnv.OLD_STATUS ?? ''}" -> "${runEnv.NEW_STATUS ?? ''}"`)
  }

  const dryRun = opts['dry-run']
  let lock
  if (!dryRun) {
    try {
      lock = await acquireLock(config.backlog.projectDir, {
        waitMs: config.sync.lockWaitMs,
        maxAgeMs: config.sync.maxRunAgeMs,
      })
    } catch (e) {
      if (!(e instanceof LockError)) throw e
      log.error(`${e.message}; nothing was written`)
      return EXIT.LOCKED
    }
  }

  try {
    // Re-read under the lock: a run that finished while we waited may have changed it.
    if (lock) state = loadState(config.backlog.projectDir)
    const ctx = {
      config,
      jira: createJira(config, log),
      backlog: createBacklog(config, runEnv),
      state,
      logger: log,
      dryRun,
    }
    const failures = []
    if (command === 'pull' || command === 'sync') {
      const r = await pull(ctx)
      failures.push(...r.failures)
      log.out(
        `pull: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.skipped} skipped, ${r.failures.length} failed${dryRun ? ' (dry run)' : ''}`,
      )
    }
    if (command === 'push' || command === 'sync' || command === 'hook') {
      const r = await push({ ...ctx, taskId })
      failures.push(...r.failures)
      log.out(`push: ${r.failures.length} failed${dryRun ? ' (dry run)' : ''}`)
    }
    return failures.length ? EXIT.FAILED : EXIT.OK
  } catch (e) {
    log.error(e.message)
    return EXIT.FAILED
  } finally {
    lock?.release()
  }
}

// Resolve symlinks so the npm `bin` shim (a symlink) also counts as running this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
