import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { acquireLock, STATE_FILE } from '../src/state.js'
import { cliProject } from './fixtures/cli-project.js'
import { makeIssue } from './fixtures/fake-jira.js'

const state = (p) => JSON.parse(readFileSync(join(p.dir, STATE_FILE), 'utf8'))

describe('sync-cli: commands', () => {
  test('unknown command prints usage and exits non-zero', async () => {
    const p = cliProject()
    const r = await p.run(['frobnicate'])
    assert.equal(r.code, 1)
    assert.match(r.err, /Usage: jira-to-backlogmd/)
  })

  test('unknown option is a usage error', async () => {
    const r = await cliProject().run(['pull', '--bogus'])
    assert.equal(r.code, 1)
  })

  test('pull imports and exits 0', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1')] })
    const r = await p.run(['pull'])
    assert.equal(r.code, 0, r.err)
    assert.equal(p.fb.tasks().length, 1)
    assert.match(r.out, /1 created/)
  })

  test('dry pull: two planned creations, no task or store record', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1'), makeIssue('PROJ-2')] })
    const r = await p.run(['pull', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.equal((r.out.match(/would create task/g) ?? []).length, 2)
    assert.equal(p.fb.writes().length, 0)
    assert.ok(!existsSync(join(p.dir, STATE_FILE)))
  })

  test('sync: import completes before write-back, under one lock', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1')] })
    await p.run(['pull'])
    const id = p.fb.tasks()[0].id
    p.fake.update('PROJ-1', { summary: 'Renamed' })
    writeFileSync(
      p.fb.env.FAKE_BACKLOG_STORE,
      JSON.stringify({
        ...JSON.parse(readFileSync(p.fb.env.FAKE_BACKLOG_STORE, 'utf8')),
        tasks: p.fb.tasks().map((t) => ({ ...t, status: 'In Progress' })),
      }),
    )
    const r = await p.run(['sync'])
    assert.equal(r.code, 0, r.err)
    assert.equal(p.fb.task(id).title, 'Renamed')
    assert.deepEqual(p.fake.transitions, [{ key: 'PROJ-1', to: 'In Progress' }])
    const order = p.fake.calls.map((c) => c.method)
    assert.ok(order.indexOf('searchIssues') < order.indexOf('transition'))
    assert.ok(!existsSync(join(p.dir, '.jira-to-backlogmd', 'lock')))
  })

  test('push writes back status', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1')] })
    await p.run(['pull'])
    const id = p.fb.tasks()[0].id
    await p.run(['push'])
    assert.deepEqual(p.fake.transitions, [])
    const store = JSON.parse(readFileSync(p.fb.env.FAKE_BACKLOG_STORE, 'utf8'))
    store.tasks[0].status = 'Done'
    writeFileSync(p.fb.env.FAKE_BACKLOG_STORE, JSON.stringify(store))
    const r = await p.run(['push'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(p.fake.transitions, [{ key: 'PROJ-1', to: 'Done' }])
    assert.equal(state(p).links[0].taskId, id)
  })
})

describe('sync-cli: hook', () => {
  const linkedProject = async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-7'), makeIssue('PROJ-8')] })
    await p.run(['pull'])
    const store = JSON.parse(readFileSync(p.fb.env.FAKE_BACKLOG_STORE, 'utf8'))
    for (const t of store.tasks) t.status = 'In Progress'
    writeFileSync(p.fb.env.FAKE_BACKLOG_STORE, JSON.stringify(store))
    p.fake.calls.length = 0
    return p
  }

  test('linked task: only its issue is considered', async () => {
    const p = await linkedProject()
    const r = await p.run(['hook'], {
      TASK_ID: 'TASK-1',
      OLD_STATUS: 'To Do',
      NEW_STATUS: 'In Progress',
    })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(p.fake.transitions, [{ key: 'PROJ-7', to: 'In Progress' }])
    assert.ok(!p.fake.calls.some((c) => c.key === 'PROJ-8'))
  })

  test('unlinked task exits zero without contacting Jira', async () => {
    const p = await linkedProject()
    const r = await p.run(['hook'], { TASK_ID: 'TASK-77' })
    assert.equal(r.code, 0)
    assert.deepEqual(p.fake.calls, [])
  })

  test('change made by the import exits zero without contacting Jira', async () => {
    const p = await linkedProject()
    const r = await p.run(['hook'], { TASK_ID: 'TASK-1', JIRA_TO_BACKLOGMD_ORIGIN: 'import' })
    assert.equal(r.code, 0)
    assert.deepEqual(p.fake.calls, [])
    assert.equal(p.jiraCreated.length, 1) // only the earlier pull
  })

  test('missing TASK_ID is a usage error', async () => {
    const r = await cliProject().run(['hook'])
    assert.equal(r.code, 1)
    assert.match(r.err, /TASK_ID/)
  })
})

describe('sync-cli: exit codes and logging', () => {
  test('configuration errors: exit 1, all problems listed, no Jira or backlog call', async () => {
    const p = cliProject({ config: { jira: {}, sync: { conflictStrategy: 'latest' } } })
    const r = await p.run(['pull'])
    assert.equal(r.code, 1)
    assert.match(r.err, /jira\.projectKey/)
    assert.match(r.err, /sync\.conflictStrategy/)
    assert.equal(p.jiraCreated.length, 0)
    assert.deepEqual(p.fb.calls(), [])
  })

  test('missing secret: exit 1 naming the variable', async () => {
    const p = cliProject()
    const r = await p.run(['pull'], { JIRA_API_TOKEN: '' })
    assert.equal(r.code, 1)
    assert.match(r.err, /JIRA_API_TOKEN/)
  })

  test('lock held by another run: exit 2, nothing written', async () => {
    const p = cliProject({
      issues: [makeIssue('PROJ-1')],
      config: { sync: { lockWaitMs: 50 } },
    })
    const lock = await acquireLock(p.dir, { waitMs: 0 })
    try {
      const r = await p.run(['pull'])
      assert.equal(r.code, 2)
      assert.match(r.err, /lock/)
      assert.equal(p.fb.writes().length, 0)
      assert.deepEqual(p.fake.calls, [])
    } finally {
      lock.release()
    }
  })

  test('partial failure: exit 3', async () => {
    const p = cliProject({
      issues: [makeIssue('PROJ-1', { summary: 'BREAKME' }), makeIssue('PROJ-2')],
    })
    p.fb.env.FAKE_BACKLOG_FAIL_ON = 'BREAKME'
    const r = await p.run(['pull'])
    assert.equal(r.code, 3)
    assert.match(r.err, /PROJ-1/)
  })

  test('corrupt store: exit 1 naming the file, no write', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1')] })
    writeFileSync(join(p.dir, STATE_FILE), '{oops')
    const r = await p.run(['pull'])
    assert.equal(r.code, 1)
    assert.ok(r.err.includes(join(p.dir, STATE_FILE)))
    assert.equal(p.fb.writes().length, 0)
  })

  test('the token never appears in output, even with --verbose', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1', { summary: 'leak tok-123-secret' })] })
    const r = await p.run(['pull', '--verbose', '--dry-run'])
    assert.ok(!`${r.out}${r.err}`.includes('tok-123-secret'))
  })

  test('--env-file supplies missing JIRA_* variables', async () => {
    const p = cliProject({ issues: [makeIssue('PROJ-1')] })
    const file = join(p.dir, 'jira.env')
    writeFileSync(file, 'JIRA_API_TOKEN=from-file-token\n')
    const r = await p.run(['pull', '--env-file', file], { JIRA_API_TOKEN: '' })
    assert.equal(r.code, 0, r.err)
    assert.equal(p.jiraCreated.at(-1).jira.token, 'from-file-token')
  })
})
