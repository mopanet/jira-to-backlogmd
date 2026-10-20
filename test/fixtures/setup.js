// Shared wiring for sync tests: config + fake Jira + fake backlog + state in a temp project.
import { BacklogCli } from '../../src/backlog-cli.js'
import { validateConfig } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { loadState } from '../../src/state.js'
import { FAKE_BACKLOG, fakeBacklog } from './fake-backlog.js'
import { FakeJiraClient } from './fake-jira.js'

export const ENV = {
  JIRA_BASE_URL: 'https://acme.atlassian.net',
  JIRA_USER_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'tok-123-secret',
}

export function rawConfig(over = {}) {
  return {
    jira: { projectKey: 'PROJ' },
    statusMapping: {
      'To Do': ['To Do'],
      'In Progress': ['In Progress', 'In Review'],
      Blocked: ['Blocked'],
      Done: ['Done', 'Closed'],
    },
    assignees: { 'jane@example.com': '@jane' },
    ...over,
  }
}

export function setup({ issues = [], tasks = [], config = {}, jira = {} } = {}) {
  const { config: cfg, errors } = validateConfig(rawConfig(config), ENV)
  if (errors.length) throw new Error(errors.join('\n'))
  const fb = fakeBacklog({ tasks })
  cfg.backlog.projectDir = fb.dir
  const fake = new FakeJiraClient({ issues, ...jira })
  const out = []
  const err = []
  const logger = createLogger({
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  })
  const backlog = new BacklogCli({ command: FAKE_BACKLOG, cwd: fb.dir, env: fb.env })
  const ctx = { config: cfg, jira: fake, backlog, logger, state: loadState(fb.dir) }
  return {
    ...ctx,
    ctx,
    fb,
    fake,
    out: () => out.join(''),
    err: () => err.join(''),
    reloadState: () => {
      ctx.state = loadState(fb.dir)
      return ctx.state
    },
  }
}
