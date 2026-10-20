// End-to-end: real `backlog` CLI (devDependency) + fake Jira served over local HTTP, so the
// onStatusChange hook (a separate process started by Backlog.md) reaches the same Jira.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { main } from '../src/cli.js'
import { STATE_FILE } from '../src/state.js'
import { FakeJiraClient, fakeJiraFetch, makeIssue } from './fixtures/fake-jira.js'

const BACKLOG = new URL('../node_modules/.bin/backlog', import.meta.url).pathname
const CLI = new URL('../src/cli.js', import.meta.url).pathname
const skip = existsSync(BACKLOG) ? false : 'backlog.md devDependency not installed'

describe('e2e: sync over a real Backlog.md project', { skip }, () => {
  let server
  let fake
  let dir
  let env

  // Async on purpose: the hook process calls back into this process's HTTP server.
  const backlog = async (args) =>
    (await promisify(execFile)(BACKLOG, args, { cwd: dir, env, encoding: 'utf8' })).stdout
  const view = async (id) => JSON.parse(await backlog(['task', 'view', id, '--json'])).task
  const run = async (argv) => {
    const out = []
    const err = []
    const code = await main(argv, {
      cwd: dir,
      env,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
    })
    return { code, out: out.join(''), err: err.join('') }
  }

  before(async () => {
    fake = new FakeJiraClient({
      issues: [
        makeIssue('PROJ-1', { summary: 'Fix login', labels: ['auth'], priority: 'High' }),
        makeIssue('PROJ-2', { summary: 'Add logout', status: 'In Progress' }),
      ],
    })
    const handle = fakeJiraFetch(fake)
    server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? Buffer.concat(chunks).toString() : undefined
      const r = await handle(`http://${req.headers.host}${req.url}`, { method: req.method, body })
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(await r.text())
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    fake.baseUrl = base
    for (const i of fake.issues.values()) i.browseUrl = `${base}/browse/${i.key}`

    dir = mkdtempSync(join(tmpdir(), 'j2b-e2e-'))
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      JIRA_BASE_URL: base,
      JIRA_USER_EMAIL: 'bot@example.com',
      JIRA_API_TOKEN: 'e2e-token-value',
    }
    await backlog(['init', 'e2e', '--defaults', '--integration-mode', 'none', '--no-git'])
    assert.equal((await run(['init'])).code, 0)
    const cfgFile = join(dir, '.jira-to-backlogmd', 'config.json')
    writeFileSync(
      cfgFile,
      readFileSync(cfgFile, 'utf8').replace('"command": "backlog"', `"command": "${BACKLOG}"`),
    )
    const blCfg = join(dir, 'backlog', 'config.yml')
    writeFileSync(
      blCfg,
      `${readFileSync(blCfg, 'utf8')}onStatusChange: '${process.execPath} ${CLI} hook'\n`,
    )
  })

  after(() => server?.close())

  test('import creates tasks with Jira fields and records links', async () => {
    const r = await run(['sync'])
    assert.equal(r.code, 0, r.err)
    const links = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')).links
    assert.deepEqual(
      links.map((l) => l.issueKey),
      ['PROJ-1', 'PROJ-2'],
    )
    const t1 = await view(links[0].taskId)
    assert.equal(t1.title, 'Fix login')
    assert.equal(t1.status, 'To Do')
    assert.deepEqual(t1.labels, ['auth'])
    assert.equal(t1.priority, 'high')
    assert.ok(t1.references.includes(`${fake.baseUrl}/browse/PROJ-1`))
    assert.equal((await view(links[1].taskId)).status, 'In Progress')
    assert.deepEqual(fake.writes(), [])
  })

  test('a local status change fires the hook, which transitions the issue', async () => {
    await backlog(['task', 'edit', 'TASK-1', '--status', 'In Progress', '--plain'])
    assert.deepEqual(fake.transitions, [{ key: 'PROJ-1', to: 'In Progress' }])
  })

  test('an import-driven status change does not bounce back to Jira', async () => {
    fake.setStatus('PROJ-2', 'Done')
    const r = await run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.equal((await view('TASK-2')).status, 'Done')
    assert.ok(!fake.transitions.some((t) => t.key === 'PROJ-2'))
  })

  test('a conflict is resolved backlog-wins with an explanatory comment', async () => {
    // Change the task file directly (no callback fires) while Jira moves elsewhere.
    const file = join(dir, (await view('TASK-1')).path)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^status: .*$/m, 'status: Done'))
    fake.setStatus('PROJ-1', 'Blocked')
    const r = await run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(fake.transitions.at(-1), { key: 'PROJ-1', to: 'Done' })
    assert.match(fake.comments.at(-1).text, /Backlog\.md took precedence/)
    assert.ok(!`${r.out}${r.err}`.includes('e2e-token-value'))
  })
})
