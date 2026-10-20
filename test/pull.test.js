import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { pull } from '../src/sync/pull.js'
import { makeTask } from './fixtures/fake-backlog.js'
import { makeIssue } from './fixtures/fake-jira.js'
import { setup } from './fixtures/setup.js'

const adf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('jira-import: creation', () => {
  test('new issue becomes a task and the link is recorded', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7', { summary: 'Fix login' })] })
    const res = await pull(s.ctx)
    assert.deepEqual(res.failures, [])
    const [task] = s.fb.tasks()
    assert.equal(task.title, 'Fix login')
    const link = s.reloadState().get('PROJ-7')
    assert.equal(link.taskId, task.id)
    assert.equal(link.lastBacklogStatus, 'To Do')
    assert.equal(link.lastJiraStatus, 'To Do')
  })

  test('re-run does not duplicate', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7'), makeIssue('PROJ-8')] })
    await pull(s.ctx)
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.tasks().length, 2)
  })
})

describe('jira-import: field mapping', () => {
  test('summary, labels, priority, status and browse-URL reference', async () => {
    const s = setup({
      issues: [
        makeIssue('PROJ-7', {
          summary: 'Fix login',
          labels: ['auth'],
          priority: 'High',
          status: 'To Do',
          description: adf('Users cannot log in.'),
        }),
      ],
    })
    await pull(s.ctx)
    const [t] = s.fb.tasks()
    assert.equal(t.title, 'Fix login')
    assert.deepEqual(t.labels, ['auth'])
    assert.equal(t.priority, 'high')
    assert.equal(t.status, 'To Do')
    assert.equal(t.description, 'Users cannot log in.')
    assert.deepEqual(t.references, ['https://acme.atlassian.net/browse/PROJ-7'])
  })

  test('a secondary Jira status imports as its Backlog.md status', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7', { status: 'In Review' })] })
    await pull(s.ctx)
    assert.equal(s.fb.tasks()[0].status, 'In Progress')
  })

  test('mapped assignee and unmapped display name', async () => {
    const s = setup({
      issues: [
        makeIssue('PROJ-1', {
          assignee: { accountId: 'a1', email: 'jane@example.com', displayName: 'Jane Doe' },
        }),
        makeIssue('PROJ-2', {
          assignee: { accountId: 'a2', email: null, displayName: 'Doe, John' },
        }),
      ],
    })
    await pull(s.ctx)
    const [a, b] = s.fb.tasks()
    assert.deepEqual(a.assignees, ['@jane'])
    assert.deepEqual(b.assignees, ['Doe John'])
  })

  test('Highest/Lowest map to high/low; unknown priorities are not set', async () => {
    const s = setup({
      issues: [
        makeIssue('PROJ-1', { priority: 'Highest' }),
        makeIssue('PROJ-2', { priority: 'Lowest' }),
        makeIssue('PROJ-3', { priority: 'P0' }),
      ],
    })
    await pull(s.ctx)
    assert.deepEqual(
      s.fb.tasks().map((t) => t.priority),
      ['high', 'low', null],
    )
  })

  test('changed Jira field is re-applied', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7', { summary: 'Old' })] })
    await pull(s.ctx)
    s.fake.update('PROJ-7', { summary: 'New title', labels: ['x'] })
    await pull({ ...s.ctx, state: s.reloadState() })
    const [t] = s.fb.tasks()
    assert.equal(t.title, 'New title')
    assert.deepEqual(t.labels, ['x'])
  })

  test('unmapped Jira status skips the issue with a warning; others continue', async () => {
    const s = setup({
      issues: [makeIssue('PROJ-1', { status: 'Weird' }), makeIssue('PROJ-2')],
    })
    const res = await pull(s.ctx)
    assert.equal(s.fb.tasks().length, 1)
    assert.match(s.err(), /PROJ-1.*"Weird"/)
    assert.deepEqual(res.failures, [])
  })

  test('issues from another project are ignored with a warning', async () => {
    const s = setup({ issues: [makeIssue('OTHER-1'), makeIssue('PROJ-2')] })
    await pull(s.ctx)
    assert.equal(s.fb.tasks().length, 1)
    assert.match(s.err(), /OTHER-1/)
  })
})

describe('jira-import: ownership boundary', () => {
  test('a task with local work keeps plan and criteria byte-for-byte', async () => {
    const s = setup({
      issues: [makeIssue('PROJ-7', { summary: 'A' })],
      tasks: [
        makeTask({
          id: 'TASK-12',
          title: 'A',
          implementationPlan: '1. do it\n2. ship',
          acceptanceCriteria: [
            { index: 1, text: 'x', checked: true },
            { index: 2, text: 'y', checked: true },
          ],
          references: ['https://github.com/acme/app/pull/1'],
        }),
      ],
    })
    s.state.set({
      taskId: 'TASK-12',
      issueKey: 'PROJ-7',
      lastBacklogStatus: 'To Do',
      lastJiraStatus: 'To Do',
      jiraUpdated: 'old',
    })
    s.fake.update('PROJ-7', { summary: 'B' })
    const before = s.fb.task('TASK-12')
    await pull(s.ctx)
    const after = s.fb.task('TASK-12')
    assert.equal(after.title, 'B')
    assert.equal(after.implementationPlan, before.implementationPlan)
    assert.deepEqual(after.acceptanceCriteria, before.acceptanceCriteria)
    assert.ok(after.references.includes('https://github.com/acme/app/pull/1'))
    const [edit] = s.fb.writes()
    for (const flag of ['--plan', '--ac', '--notes', '--final-summary', '--ref', '--dep']) {
      assert.ok(!edit.argv.includes(flag), flag)
    }
  })

  test('unchanged issue: no write at all', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7')] })
    await pull(s.ctx)
    const writes = s.fb.writes().length
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.writes().length, writes)
  })

  test('Jira updated but Jira-owned fields equal: no write', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7')] })
    await pull(s.ctx)
    s.fake.update('PROJ-7', {})
    const writes = s.fb.writes().length
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.writes().length, writes)
  })
})

describe('jira-import: status', () => {
  test('status pulled from Jira is written with the import origin marker', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7')] })
    await pull(s.ctx)
    s.fake.setStatus('PROJ-7', 'In Progress')
    await pull({ ...s.ctx, state: s.reloadState() })
    const [t] = s.fb.tasks()
    assert.equal(t.status, 'In Progress')
    const edit = s.fb.writes().at(-1)
    assert.ok(edit.argv.includes('--status'))
    assert.equal(edit.origin, 'import')
    assert.equal(s.fake.writes().length, 0)
    const link = s.reloadState().get('PROJ-7')
    assert.equal(link.lastBacklogStatus, 'In Progress')
    assert.equal(link.lastJiraStatus, 'In Progress')
  })

  test('a local status change is left for the write-back, not overwritten', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7')] })
    await pull(s.ctx)
    const id = s.fb.tasks()[0].id
    await s.backlog.editTask(id, { status: 'Done' })
    s.fake.setStatus('PROJ-7', 'Blocked')
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.task(id).status, 'Done')
    assert.equal(s.reloadState().get('PROJ-7').lastJiraStatus, 'To Do')
  })
})

describe('jira-import: scope and failures', () => {
  test('issue moved out of scope keeps its task and is logged', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7', { summary: 'Keep' })] })
    await pull(s.ctx)
    s.fake.outOfScope.add('PROJ-7')
    s.fake.update('PROJ-7', { summary: 'Changed' })
    const writes = s.fb.writes().length
    await pull({ ...s.ctx, state: s.reloadState() })
    assert.equal(s.fb.tasks()[0].title, 'Keep')
    assert.equal(s.fb.writes().length, writes)
    assert.match(s.err(), /PROJ-7/)
  })

  test('one failing issue of ten: nine imported, failure names the key', async () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue(`PROJ-${i + 1}`, { summary: i === 4 ? 'BREAKME' : `Issue ${i + 1}` }),
    )
    const s = setup({ issues })
    s.backlog.env.FAKE_BACKLOG_FAIL_ON = 'BREAKME'
    const res = await pull(s.ctx)
    assert.equal(s.fb.tasks().length, 9)
    assert.equal(res.failures.length, 1)
    assert.equal(res.failures[0].key, 'PROJ-5')
    assert.match(s.err(), /PROJ-5/)
  })

  test('dangling link is reported and the rest processed', async () => {
    const s = setup({ issues: [makeIssue('PROJ-7'), makeIssue('PROJ-8')] })
    s.state.set({
      taskId: 'TASK-40',
      issueKey: 'PROJ-7',
      lastBacklogStatus: 'To Do',
      lastJiraStatus: 'To Do',
    })
    await pull(s.ctx)
    assert.match(s.err(), /TASK-40.*PROJ-7|PROJ-7.*TASK-40/)
    assert.equal(s.fb.tasks().length, 1)
  })
})

describe('sync-cli: dry pull', () => {
  test('two new issues print two planned creations and write nothing', async () => {
    const s = setup({ issues: [makeIssue('PROJ-1'), makeIssue('PROJ-2')] })
    await pull({ ...s.ctx, dryRun: true })
    assert.equal((s.out().match(/would create task/g) ?? []).length, 2)
    assert.equal(s.fb.writes().length, 0)
    assert.equal(s.reloadState().all().length, 0)
  })
})
