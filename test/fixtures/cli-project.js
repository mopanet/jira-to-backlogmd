// A temp Backlog.md project wired for `main()`: config file, fake backlog, fake Jira.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../../src/cli.js'
import { FAKE_BACKLOG, fakeBacklog } from './fake-backlog.js'
import { FakeJiraClient } from './fake-jira.js'
import { ENV, rawConfig } from './setup.js'

export function cliProject({ issues = [], tasks = [], config = {}, jira = {}, env = {} } = {}) {
  const fb = fakeBacklog({ tasks })
  mkdirSync(join(fb.dir, '.jira-to-backlogmd'), { recursive: true })
  const cfg = rawConfig({ backlog: { command: FAKE_BACKLOG }, ...config })
  writeFileSync(join(fb.dir, '.jira-to-backlogmd', 'config.json'), JSON.stringify(cfg))
  const fake = new FakeJiraClient({ issues, ...jira })
  const jiraCreated = []
  const run = async (argv, extraEnv = {}) => {
    const out = []
    const err = []
    const code = await main(argv, {
      cwd: fb.dir,
      env: { ...fb.env, ...ENV, ...env, ...extraEnv },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      createJira: (c) => {
        jiraCreated.push(c)
        return fake
      },
    })
    return { code, out: out.join(''), err: err.join('') }
  }
  return { fb, fake, run, dir: fb.dir, jiraCreated }
}
