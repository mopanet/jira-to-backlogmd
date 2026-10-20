import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  acquireLock,
  LOCK_FILE,
  LockError,
  loadState,
  resolveLinkedTasks,
  STATE_FILE,
  StateError,
} from '../src/state.js'

const project = () => mkdtempSync(join(tmpdir(), 'j2b-state-'))
const record = (over = {}) => ({
  taskId: 'TASK-12',
  issueKey: 'PROJ-7',
  lastBacklogStatus: 'To Do',
  lastJiraStatus: 'To Do',
  jiraUpdated: '2026-10-01T10:00:00.000+0000',
  ...over,
})

describe('sync-state: persistence', () => {
  test('record after import holds both last synced statuses', () => {
    const dir = project()
    const state = loadState(dir)
    state.set(record())
    state.save()
    const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'))
    assert.equal(saved.version, 1)
    assert.deepEqual(saved.links[0], {
      taskId: 'TASK-12',
      issueKey: 'PROJ-7',
      lastBacklogStatus: 'To Do',
      lastJiraStatus: 'To Do',
      jiraUpdated: '2026-10-01T10:00:00.000+0000',
      linkedUrls: [],
      summaryPosted: false,
    })
    const again = loadState(dir)
    assert.equal(again.get('PROJ-7').taskId, 'TASK-12')
    assert.equal(again.byTask('task-12').issueKey, 'PROJ-7')
  })

  test('the store is human-readable, sorted and stable', () => {
    const dir = project()
    const state = loadState(dir)
    state.set(record({ issueKey: 'PROJ-9', taskId: 'TASK-2' }))
    state.set(record({ issueKey: 'PROJ-10', taskId: 'TASK-3' }))
    state.save()
    const text = readFileSync(join(dir, STATE_FILE), 'utf8')
    assert.ok(text.endsWith('\n') && text.includes('\n  "links": ['))
    assert.deepEqual(
      JSON.parse(text).links.map((l) => l.issueKey),
      ['PROJ-9', 'PROJ-10'],
    )
  })

  test('store survives a fresh checkout at another path', () => {
    const dir = project()
    const state = loadState(dir)
    state.set(record())
    state.save()
    const clone = project()
    cpSync(join(dir, '.jira-to-backlogmd'), join(clone, '.jira-to-backlogmd'), { recursive: true })
    assert.equal(loadState(clone).get('PROJ-7').taskId, 'TASK-12')
  })

  test('a missing store is empty', () => {
    assert.deepEqual(loadState(project()).all(), [])
  })
})

describe('sync-state: atomic writes', () => {
  test('a crash before the rename leaves the previous complete content', () => {
    const dir = project()
    const state = loadState(dir)
    state.set(record())
    state.save()
    state.set(record({ issueKey: 'PROJ-8', taskId: 'TASK-13' }))
    assert.throws(() =>
      state.save({
        beforeRename: () => {
          throw new Error('killed')
        },
      }),
    )
    const reloaded = loadState(dir)
    assert.deepEqual(
      reloaded.all().map((r) => r.issueKey),
      ['PROJ-7'],
    )
  })

  test('no temp file is left behind after a save', () => {
    const dir = project()
    const state = loadState(dir)
    state.set(record())
    state.save()
    assert.deepEqual(readdirSync(join(dir, '.jira-to-backlogmd')), ['state.json'])
  })
})

describe('sync-state: corrupt store', () => {
  test('invalid content raises StateError naming the path', () => {
    const dir = project()
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(join(dir, STATE_FILE), '{"version":1,"links":[{"taskId"')
    assert.throws(
      () => loadState(dir),
      (e) => e instanceof StateError && e.message.includes(join(dir, STATE_FILE)),
    )
  })

  test('valid JSON with the wrong shape is also corrupt', () => {
    const dir = project()
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(join(dir, STATE_FILE), '{"version":1,"links":[{"taskId":3}]}')
    assert.throws(() => loadState(dir), StateError)
  })
})

describe('sync-state: lock', () => {
  test('a second run waits briefly then fails naming the holder', async () => {
    const dir = project()
    const first = await acquireLock(dir, { waitMs: 0 })
    const started = Date.now()
    await assert.rejects(
      acquireLock(dir, { waitMs: 150, pollMs: 20 }),
      (e) => e instanceof LockError && e.message.includes(String(process.pid)),
    )
    assert.ok(Date.now() - started >= 140)
    first.release()
    assert.ok(!existsSync(join(dir, LOCK_FILE)))
  })

  test('released lock can be acquired again', async () => {
    const dir = project()
    ;(await acquireLock(dir, { waitMs: 0 })).release()
    ;(await acquireLock(dir, { waitMs: 0 })).release()
  })

  test('stale lock of a dead process is taken over', async () => {
    const dir = project()
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    )
    const lock = await acquireLock(dir, { waitMs: 0, isAlive: () => false })
    assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')).pid, process.pid)
    lock.release()
  })

  test('a lock older than the max run age is stale even if the pid is alive', async () => {
    const dir = project()
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: process.pid, startedAt: '2000-01-01T00:00:00Z' }),
    )
    const lock = await acquireLock(dir, { waitMs: 0, maxAgeMs: 1000 })
    lock.release()
  })
})

describe('sync-state: dangling links', () => {
  test('records whose task no longer exists are reported and the rest processed', async () => {
    const records = [record(), record({ issueKey: 'PROJ-8', taskId: 'TASK-13' })]
    const { resolved, dangling } = await resolveLinkedTasks(records, async (id) =>
      id === 'TASK-13' ? { id } : null,
    )
    assert.deepEqual(
      dangling.map((r) => `${r.taskId} ${r.issueKey}`),
      ['TASK-12 PROJ-7'],
    )
    assert.deepEqual(
      resolved.map((r) => r.task.id),
      ['TASK-13'],
    )
  })
})
