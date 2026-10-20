import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BacklogCli, BacklogCliError } from '../src/backlog-cli.js'
import { FAKE_BACKLOG, fakeBacklog, makeTask } from './fixtures/fake-backlog.js'

const cliFor = (fb) => new BacklogCli({ command: FAKE_BACKLOG, cwd: fb.dir, env: fb.env })

describe('backlog-cli: reads', () => {
  test('version is parsed from --version', async () => {
    assert.equal(await cliFor(fakeBacklog()).version(), '1.54.0')
  })

  test('listTasks parses the task-list JSON', async () => {
    const fb = fakeBacklog({ tasks: [makeTask({ id: 'TASK-1' }), makeTask({ id: 'TASK-2' })] })
    const tasks = await cliFor(fb).listTasks()
    assert.deepEqual(
      tasks.map((t) => t.id),
      ['TASK-1', 'TASK-2'],
    )
  })

  test('viewTask returns the task, or null when it does not exist', async () => {
    const fb = fakeBacklog({ tasks: [makeTask({ id: 'TASK-1', title: 'A' })] })
    const cli = cliFor(fb)
    assert.equal((await cli.viewTask('TASK-1')).title, 'A')
    assert.equal(await cli.viewTask('TASK-9'), null)
  })

  test('unexpected JSON kind is an error', async () => {
    const fb = fakeBacklog()
    const cli = new BacklogCli({ command: process.execPath, cwd: fb.dir, env: fb.env })
    cli.run = async () => '{"schemaVersion":2,"kind":"other"}'
    await assert.rejects(cli.listTasks(), BacklogCliError)
  })
})

describe('backlog-cli: writes', () => {
  test('createTask builds argv without a shell and returns the new id', async () => {
    const fb = fakeBacklog()
    const id = await cliFor(fb).createTask({
      title: 'Fix "login"; rm -rf /',
      description: 'Line 1\n\n`code` $HOME',
      status: 'To Do',
      assignees: ['@jane'],
      labels: ['auth', 'ui'],
      priority: 'high',
      references: ['https://acme.atlassian.net/browse/PROJ-7'],
    })
    assert.equal(id, 'TASK-1')
    const t = fb.task('TASK-1')
    assert.equal(t.title, 'Fix "login"; rm -rf /')
    assert.equal(t.description, 'Line 1\n\n`code` $HOME')
    assert.deepEqual(t.labels, ['auth', 'ui'])
    assert.deepEqual(t.assignees, ['@jane'])
    assert.equal(t.priority, 'high')
    assert.deepEqual(t.references, ['https://acme.atlassian.net/browse/PROJ-7'])
    const [call] = fb.calls()
    assert.deepEqual(call.argv.slice(0, 2), ['task', 'create'])
    assert.deepEqual(call.argv.slice(-2), ['--', 'Fix "login"; rm -rf /'])
  })

  test('editTask maps changes to flags; empty lists clear', async () => {
    const fb = fakeBacklog({ tasks: [makeTask({ labels: ['x'], assignees: ['@a'] })] })
    await cliFor(fb).editTask('TASK-1', {
      title: 'New',
      status: 'In Progress',
      labels: [],
      assignees: [],
      addReferences: ['https://x.example/1'],
    })
    const t = fb.task('TASK-1')
    assert.equal(t.title, 'New')
    assert.equal(t.status, 'In Progress')
    assert.deepEqual(t.labels, [])
    assert.deepEqual(t.assignees, [])
    assert.deepEqual(t.references, ['https://x.example/1'])
  })

  test('every write carries JIRA_TO_BACKLOGMD_ORIGIN=import; reads do not need it', async () => {
    const fb = fakeBacklog({ tasks: [makeTask()] })
    const cli = cliFor(fb)
    await cli.viewTask('TASK-1')
    await cli.editTask('TASK-1', { status: 'Done' })
    await cli.createTask({ title: 'B' })
    const calls = fb.calls()
    assert.equal(calls[1].origin, 'import')
    assert.equal(calls[2].origin, 'import')
  })

  test('non-zero exit raises BacklogCliError with the exit code and stderr', async () => {
    const fb = fakeBacklog({ tasks: [makeTask()] })
    fb.env.FAKE_BACKLOG_FAIL_ON = 'edit'
    await assert.rejects(
      cliFor(fb).editTask('TASK-1', { title: 'x' }),
      (e) => e instanceof BacklogCliError && e.exitCode === 1 && /simulated/.test(e.message),
    )
  })

  test('a missing executable raises BacklogCliError', async () => {
    const fb = fakeBacklog()
    const cli = new BacklogCli({ command: '/nonexistent/backlog', cwd: fb.dir, env: fb.env })
    await assert.rejects(cli.version(), BacklogCliError)
  })
})
