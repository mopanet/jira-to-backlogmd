import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { push } from '../src/sync/push.js'
import { makeTask } from './fixtures/fake-backlog.js'
import { makeIssue } from './fixtures/fake-jira.js'
import { setup } from './fixtures/setup.js'

/** One linked pair; `last` = statuses at the last sync (default: both equal to `was`). */
function linked({
  was = 'To Do',
  task = {},
  issue = {},
  last = {},
  config,
  jira,
  record = {},
  extra = [],
} = {}) {
  const t = makeTask({ id: 'TASK-12', title: 'Fix login', status: was, ...task })
  const i = makeIssue('PROJ-7', { status: was, ...issue })
  const s = setup({
    tasks: [t, ...extra.map((e) => e.task)],
    issues: [i, ...extra.map((e) => e.issue)],
    config,
    jira,
  })
  s.state.set({
    taskId: 'TASK-12',
    issueKey: 'PROJ-7',
    lastBacklogStatus: last.backlog ?? was,
    lastJiraStatus: last.jira ?? was,
    ...record,
  })
  for (const e of extra) s.state.set(e.record)
  return s
}

describe('jira-writeback: status transitions', () => {
  test('task moved to In Progress transitions the issue to the first mapped status', async () => {
    const s = linked({ task: { status: 'In Progress' } })
    const res = await push(s.ctx)
    assert.deepEqual(res.failures, [])
    assert.deepEqual(s.fake.transitions, [{ key: 'PROJ-7', to: 'In Progress' }])
    const r = s.reloadState().get('PROJ-7')
    assert.equal(r.lastBacklogStatus, 'In Progress')
    assert.equal(r.lastJiraStatus, 'In Progress')
  })

  test('task completed transitions to the first status mapped to Done', async () => {
    const s = linked({ was: 'In Progress', task: { status: 'Done' } })
    await push(s.ctx)
    assert.deepEqual(s.fake.transitions, [{ key: 'PROJ-7', to: 'Done' }])
  })

  test('no transition when Jira is already in a secondary mapped status', async () => {
    const s = linked({
      task: { status: 'In Progress' },
      issue: { status: 'In Review' },
      last: { jira: 'To Do' },
    })
    await push(s.ctx)
    assert.deepEqual(s.fake.transitions, [])
    const r = s.reloadState().get('PROJ-7')
    assert.equal(r.lastBacklogStatus, 'In Progress')
    assert.equal(r.lastJiraStatus, 'In Review')
  })

  test('unchanged task status sends nothing', async () => {
    const s = linked()
    await push(s.ctx)
    assert.deepEqual(s.fake.writes(), [])
  })

  test('missing direct transition is reported with key, status and target', async () => {
    const s = linked({
      was: 'To Do',
      task: { status: 'Done' },
      jira: { workflow: { 'To Do': ['In Progress'] } },
    })
    const res = await push(s.ctx)
    assert.deepEqual(s.fake.transitions, [])
    assert.equal(res.failures.length, 1)
    assert.match(res.failures[0].message, /PROJ-7.*"To Do".*"Done"/)
    assert.equal(s.fake.issue('PROJ-7').status, 'To Do')
    assert.equal(s.state.get('PROJ-7').lastBacklogStatus, 'To Do')
  })

  test('a Jira error on one of five transitions: four applied, failure names task and issue', async () => {
    const extra = [8, 9, 10, 11].map((n) => ({
      task: makeTask({ id: `TASK-${n}`, status: 'In Progress' }),
      issue: makeIssue(`PROJ-${n}`),
      record: {
        taskId: `TASK-${n}`,
        issueKey: `PROJ-${n}`,
        lastBacklogStatus: 'To Do',
        lastJiraStatus: 'To Do',
      },
    }))
    const s = linked({
      task: { status: 'In Progress' },
      extra,
      jira: { fail: { transition: ['PROJ-9'] } },
    })
    const res = await push(s.ctx)
    assert.equal(s.fake.transitions.length, 4)
    assert.equal(res.failures.length, 1)
    assert.match(res.failures[0].message, /simulated/)
    assert.equal(res.failures[0].key, 'TASK-9 PROJ-9')
  })
})

describe('jira-writeback: remote links', () => {
  test('a pull request reference becomes a remote link titled with task id and host path', async () => {
    const s = linked({
      task: {
        references: [
          'https://acme.atlassian.net/browse/PROJ-7',
          'https://github.com/acme/app/pull/42',
          'src/local/file.js',
        ],
      },
    })
    await push(s.ctx)
    assert.deepEqual(s.fake.links('PROJ-7'), [
      {
        url: 'https://github.com/acme/app/pull/42',
        title: 'TASK-12: github.com/acme/app/pull/42',
      },
    ])
    assert.deepEqual(s.reloadState().get('PROJ-7').linkedUrls, [
      'https://github.com/acme/app/pull/42',
    ])
  })

  test('repeated run keeps exactly one link per URL and sends no new request', async () => {
    const s = linked({ task: { references: ['https://github.com/acme/app/pull/42'] } })
    await push(s.ctx)
    await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fake.links('PROJ-7').length, 1)
    assert.equal(s.fake.calls.filter((c) => c.method === 'addRemoteLink').length, 1)
  })

  test('the globalId is stable per task and URL', async () => {
    const s = linked({ task: { references: ['https://github.com/acme/app/pull/42'] } })
    await push(s.ctx)
    const [globalId] = s.fake.remoteLinks.get('PROJ-7').keys()
    assert.match(globalId, /^jira-to-backlogmd:TASK-12:[0-9a-f]{40}$/)
  })
})

describe('jira-writeback: final summary comment', () => {
  test('completed task with summary gets one comment with task id and summary', async () => {
    const s = linked({
      was: 'In Progress',
      task: { status: 'Done', finalSummary: 'Replaced the token parser' },
    })
    await push(s.ctx)
    assert.equal(s.fake.comments.length, 1)
    assert.match(s.fake.comments[0].text, /TASK-12/)
    assert.match(s.fake.comments[0].text, /Replaced the token parser/)
    assert.equal(s.reloadState().get('PROJ-7').summaryPosted, true)
  })

  test('completed task without summary: no comment', async () => {
    const s = linked({ was: 'In Progress', task: { status: 'Done' } })
    await push(s.ctx)
    assert.equal(s.fake.comments.length, 0)
  })

  test('re-run after completion posts no further comment', async () => {
    const s = linked({ was: 'In Progress', task: { status: 'Done', finalSummary: 'S' } })
    await push(s.ctx)
    await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fake.comments.length, 1)
  })

  test('reopened and completed again posts again', async () => {
    const s = linked({ was: 'In Progress', task: { status: 'Done', finalSummary: 'S' } })
    await push(s.ctx)
    await s.backlog.editTask('TASK-12', { status: 'In Progress' })
    await push({ ...s.ctx, state: s.reloadState() })
    await s.backlog.editTask('TASK-12', { status: 'Done' })
    await push({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fake.comments.length, 2)
  })
})

describe('jira-writeback: conflicts', () => {
  const conflict = (strategy) =>
    linked({
      was: 'In Progress',
      task: { status: 'Done' },
      issue: { status: 'Blocked' },
      last: { backlog: 'In Progress', jira: 'In Progress' },
      config: { sync: { conflictStrategy: strategy } },
    })

  test('backlog-wins transitions and explains in a comment', async () => {
    const s = conflict('backlog-wins')
    const res = await push(s.ctx)
    assert.deepEqual(res.failures, [])
    assert.deepEqual(s.fake.transitions, [{ key: 'PROJ-7', to: 'Done' }])
    const [c] = s.fake.comments
    assert.match(c.text, /In Progress.*Done/)
    assert.match(c.text, /In Progress.*Blocked/)
    assert.match(c.text, /Backlog\.md took precedence/)
  })

  test('jira-wins sets the task to the mapped Jira status and updates the store', async () => {
    const s = conflict('jira-wins')
    await push(s.ctx)
    assert.deepEqual(s.fake.transitions, [])
    assert.equal(s.fb.task('TASK-12').status, 'Blocked')
    assert.equal(s.fb.writes().at(-1).origin, 'import')
    const r = s.reloadState().get('PROJ-7')
    assert.equal(r.lastBacklogStatus, 'Blocked')
    assert.equal(r.lastJiraStatus, 'Blocked')
  })

  test('skip changes neither side and reports both statuses', async () => {
    const s = conflict('skip')
    const res = await push(s.ctx)
    assert.deepEqual(s.fake.writes(), [])
    assert.equal(s.fb.task('TASK-12').status, 'Done')
    assert.equal(res.failures.length, 1)
    assert.match(res.failures[0].message, /"Done".*"Blocked"/)
  })

  test('Jira moved to a status mapped to the new Backlog status is not a conflict', async () => {
    const s = linked({
      was: 'In Progress',
      task: { status: 'Done' },
      issue: { status: 'Closed' },
      config: { sync: { conflictStrategy: 'skip' } },
    })
    const res = await push(s.ctx)
    assert.deepEqual(res.failures, [])
    assert.deepEqual(s.fake.transitions, [])
  })
})

describe('jira-writeback: scope and safety', () => {
  test('only the given task is considered', async () => {
    const extra = [
      {
        task: makeTask({ id: 'TASK-13', status: 'In Progress' }),
        issue: makeIssue('PROJ-8'),
        record: {
          taskId: 'TASK-13',
          issueKey: 'PROJ-8',
          lastBacklogStatus: 'To Do',
          lastJiraStatus: 'To Do',
        },
      },
    ]
    const s = linked({ task: { status: 'In Progress' }, extra })
    await push({ ...s.ctx, taskId: 'task-12' })
    assert.deepEqual(s.fake.transitions, [{ key: 'PROJ-7', to: 'In Progress' }])
    assert.ok(!s.fake.calls.some((c) => c.key === 'PROJ-8'))
  })

  test('dangling link is reported, other records processed', async () => {
    const extra = [
      {
        task: makeTask({ id: 'TASK-13', status: 'In Progress' }),
        issue: makeIssue('PROJ-8'),
        record: {
          taskId: 'TASK-13',
          issueKey: 'PROJ-8',
          lastBacklogStatus: 'To Do',
          lastJiraStatus: 'To Do',
        },
      },
    ]
    const s = linked({ extra })
    s.state.set({
      taskId: 'TASK-99',
      issueKey: 'PROJ-9',
      lastBacklogStatus: 'To Do',
      lastJiraStatus: 'To Do',
    })
    await push(s.ctx)
    assert.match(s.err(), /TASK-99.*PROJ-9/)
    assert.deepEqual(s.fake.transitions, [{ key: 'PROJ-8', to: 'In Progress' }])
  })

  test('dry-run prints transition, link, comment and store update, performs none', async () => {
    const s = linked({
      was: 'In Progress',
      task: {
        status: 'Done',
        finalSummary: 'S',
        references: ['https://github.com/acme/app/pull/42'],
      },
    })
    await push({ ...s.ctx, dryRun: true })
    const out = s.out()
    assert.match(out, /would transition PROJ-7 .*"Done"/)
    assert.match(out, /would add remote link .*pull\/42/)
    assert.match(out, /would comment on PROJ-7/)
    assert.match(out, /would update the store/)
    assert.deepEqual(s.fake.writes(), [])
    assert.equal(s.reloadState().all().length, 0)
  })
})
