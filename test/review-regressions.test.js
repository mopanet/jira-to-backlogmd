// Regression tests for findings of the pre-landing review (branch feat/jira-backlogmd-sync).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { BacklogCli } from '../src/backlog-cli.js'
import { validateConfig } from '../src/config.js'
import { JiraCloudClient } from '../src/jira/client.js'
import { acquireLock, LOCK_FILE, loadState, STATE_FILE, StateError } from '../src/state.js'
import { desiredFields, pull } from '../src/sync/pull.js'
import { push } from '../src/sync/push.js'
import { FAKE_BACKLOG, fakeBacklog } from './fixtures/fake-backlog.js'
import { makeIssue } from './fixtures/fake-jira.js'
import { ENV, rawConfig, setup } from './fixtures/setup.js'

describe('review: deferred conflict does not get stuck', () => {
  test('after a skipped conflict and a local revert, the Jira status is imported', async () => {
    const s = setup({
      issues: [makeIssue('PROJ-7', { status: 'In Progress' })],
      config: { sync: { conflictStrategy: 'skip' } },
    })
    await pull(s.ctx)
    const id = s.fb.tasks()[0].id
    await s.backlog.editTask(id, { status: 'Done' })
    s.fake.setStatus('PROJ-7', 'Blocked')
    await pull({ ...s.ctx, state: s.reloadState() })
    await push({ ...s.ctx, state: s.reloadState() })
    await s.backlog.editTask(id, { status: 'In Progress' })
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.task(id).status, 'Blocked')
  })
})

describe('review: titles that look like flags', () => {
  test('a summary starting with "-" is passed after "--"', async () => {
    const fb = fakeBacklog()
    const cli = new BacklogCli({ command: FAKE_BACKLOG, cwd: fb.dir, env: fb.env })
    await cli.createTask({ title: '--status=Done', status: 'To Do' })
    const [call] = fb.calls()
    assert.deepEqual(call.argv.slice(-2), ['--', '--status=Done'])
  })

  test('state records with option-like task ids are corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-rr-'))
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    const rec = { taskId: '-h', issueKey: 'PROJ-1', lastBacklogStatus: 'a', lastJiraStatus: 'b' }
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: 1, links: [rec] }))
    assert.throws(() => loadState(dir), StateError)
  })
})

describe('review: duplicate links in the store', () => {
  for (const [name, b] of [
    ['task id', { taskId: 'TASK-1', issueKey: 'PROJ-2' }],
    ['issue key', { taskId: 'TASK-2', issueKey: 'PROJ-1' }],
  ]) {
    test(`a duplicate ${name} makes the store corrupt`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'j2b-rr-'))
      mkdirSync(join(dir, '.jira-to-backlogmd'))
      const base = { lastBacklogStatus: 'To Do', lastJiraStatus: 'To Do' }
      const links = [
        { taskId: 'TASK-1', issueKey: 'PROJ-1', ...base },
        { ...b, ...base },
      ]
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: 1, links }))
      assert.throws(() => loadState(dir), /duplicate/)
    })
  }
})

describe('review: stale lock takeover', () => {
  test('a fresh lock written after the stale read is not deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-rr-'))
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    const file = join(dir, LOCK_FILE)
    const stale = { pid: 999999, startedAt: new Date().toISOString(), token: 'old' }
    writeFileSync(file, JSON.stringify(stale))
    let swapped = false
    // Another run replaces the stale lock between our read and our takeover.
    const isAlive = (pid) => {
      if (pid === 999999 && !swapped) {
        swapped = true
        const other = { pid: process.pid, startedAt: new Date().toISOString(), token: 'other' }
        writeFileSync(file, JSON.stringify(other))
      }
      return pid === process.pid
    }
    await assert.rejects(acquireLock(dir, { waitMs: 50, pollMs: 10, isAlive }), /holds the lock/)
  })
})

describe('review: Jira client retries', () => {
  const client = (responses) => {
    const calls = []
    const sleeps = []
    const c = new JiraCloudClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@example.com',
      token: 'tok-123-secret',
      sleep: async (ms) => sleeps.push(ms),
      fetch: async (_url, init) => {
        calls.push(init)
        const r = responses.shift()
        if (r instanceof Error) throw r
        return new Response(r.body ? JSON.stringify(r.body) : null, {
          status: r.status,
          headers: r.headers ?? {},
        })
      },
    })
    return { c, calls, sleeps }
  }

  test('a comment POST is not retried after a 502 (it may have been applied)', async () => {
    const { c, calls } = client([{ status: 502 }, { status: 201 }])
    await assert.rejects(c.addComment('PROJ-1', 'x'))
    assert.equal(calls.length, 1)
  })

  test('a transition POST is not retried after a network error', async () => {
    const { c, calls } = client([new Error('socket hang up'), { status: 204 }])
    await assert.rejects(c.transition('PROJ-1', '31'))
    assert.equal(calls.length, 1)
  })

  test('a POST is retried after 429 (not applied)', async () => {
    const { c, calls } = client([{ status: 429, headers: { 'retry-after': '1' } }, { status: 201 }])
    await c.addComment('PROJ-1', 'x')
    assert.equal(calls.length, 2)
  })

  test('Retry-After is capped at 60 s', async () => {
    const { c, sleeps } = client([
      { status: 429, headers: { 'retry-after': '3600' } },
      { status: 200, body: {} },
    ])
    await c.myself()
    assert.deepEqual(sleeps, [60_000])
  })

  test('every request carries a timeout signal', async () => {
    const { c, calls } = client([{ status: 200, body: {} }])
    await c.myself()
    assert.ok(calls[0].signal instanceof AbortSignal)
  })
})

describe('review: description size in bytes', () => {
  test('a multi-byte description is truncated below the argv byte limit', () => {
    const text = '漢'.repeat(60_000)
    const description = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    }
    const { config } = validateConfig(rawConfig(), ENV)
    const d = desiredFields(makeIssue('PROJ-1', { description }), config).description
    assert.ok(Buffer.byteLength(d) <= 110_000, String(Buffer.byteLength(d)))
    assert.match(d, /Truncated/)
    assert.ok(!d.includes('�'))
  })
})

describe('review: write-back persists progress step by step', () => {
  test('a failing remote link still records the completed transition', async () => {
    const s = setup({
      issues: [makeIssue('PROJ-7')],
      jira: { fail: { addRemoteLink: ['PROJ-7'] } },
    })
    await pull(s.ctx)
    const id = s.fb.tasks()[0].id
    await s.backlog.editTask(id, {
      status: 'In Progress',
      addReferences: ['https://x.example/pr/1'],
    })
    const res = await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(res.failures.length, 1)
    assert.equal(s.reloadState().get('PROJ-7').lastBacklogStatus, 'In Progress')
  })
})

describe('review: transport and secret hygiene', () => {
  test('JIRA_BASE_URL must be https unless it is a loopback address', () => {
    const errs = (url) => validateConfig(rawConfig(), { ...ENV, JIRA_BASE_URL: url }).errors
    assert.ok(errs('http://acme.atlassian.net').some((e) => /https/.test(e)))
    assert.deepEqual(errs('http://127.0.0.1:8080'), [])
    assert.deepEqual(errs('http://localhost:8080'), [])
    assert.deepEqual(errs('https://acme.atlassian.net'), [])
  })

  test('the backlog child process does not receive the Jira credentials', () => {
    const fb = fakeBacklog()
    const cli = new BacklogCli({ command: FAKE_BACKLOG, cwd: fb.dir, env: { ...fb.env, ...ENV } })
    assert.equal(cli.env.JIRA_API_TOKEN, undefined)
    assert.equal(cli.env.JIRA_USER_EMAIL, undefined)
    assert.equal(cli.env.FAKE_BACKLOG_STORE, fb.env.FAKE_BACKLOG_STORE)
  })
})

describe('review round 2: progress around conflict comments and lock takeover', () => {
  test('backlog-wins: a failing conflict comment still records the transition', async () => {
    const s = setup({
      issues: [makeIssue('PROJ-7', { status: 'In Progress' })],
      jira: { fail: { addComment: ['PROJ-7'] } },
    })
    await pull(s.ctx)
    const id = s.fb.tasks()[0].id
    await s.backlog.editTask(id, { status: 'Done' })
    s.fake.setStatus('PROJ-7', 'Blocked')
    const first = await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(first.failures.length, 1)
    assert.equal(s.reloadState().get('PROJ-7').lastBacklogStatus, 'Done')
    await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fake.transitions.length, 1)
  })

  test('a takeover mutex left by a crashed run is cleared and the stale lock taken over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-rr-'))
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    const file = join(dir, LOCK_FILE)
    writeFileSync(file, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }))
    writeFileSync(`${file}.takeover`, '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${file}.takeover`, old, old)
    const lock = await acquireLock(dir, { waitMs: 500, pollMs: 10, isAlive: () => false })
    lock.release()
  })
})
