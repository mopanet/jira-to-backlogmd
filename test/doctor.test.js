import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { STATE_FILE } from '../src/state.js'
import { cliProject } from './fixtures/cli-project.js'
import { makeIssue } from './fixtures/fake-jira.js'

function healthy(opts = {}) {
  const p = cliProject({ issues: [makeIssue('PROJ-1')], ...opts })
  mkdirSync(join(p.dir, 'backlog'), { recursive: true })
  writeFileSync(
    join(p.dir, 'backlog', 'config.yml'),
    'project_name: "demo"\nauto_commit: true\nonStatusChange: \'jira-to-backlogmd hook\'\n',
  )
  return p
}

const line = (out, name) => out.split('\n').find((l) => l.includes(name)) ?? ''

describe('sync-cli: doctor', () => {
  test('all checks pass: each listed as pass, exit 0', async () => {
    const p = healthy()
    const r = await p.run(['doctor'])
    assert.equal(r.code, 0, r.out + r.err)
    for (const name of [
      'backlog CLI',
      'Backlog.md project',
      'configuration',
      'Jira authentication',
      'Jira project access',
      'onStatusChange hook',
      'autoCommit',
    ]) {
      assert.match(line(r.out, name), /^PASS/, name)
    }
  })

  test('token lacks write scope: transitions refused, the scope is named, exit non-zero', async () => {
    const p = healthy({ jira: { fail: { getTransitions: ['PROJ-1'] } } })
    const r = await p.run(['doctor'])
    assert.equal(r.code, 3)
    assert.match(line(r.out, 'Jira project access'), /^FAIL.*write:jira-work/)
  })

  test('unsupported backlog version fails', async () => {
    const p = healthy()
    const r = await p.run(['doctor'], { FAKE_BACKLOG_VERSION: '1.20.0' })
    assert.match(line(r.out, 'backlog CLI'), /^FAIL.*1\.20\.0/)
    assert.equal(r.code, 3)
  })

  test('missing hook and autoCommit off are reported as failures with a hint', async () => {
    const p = healthy()
    writeFileSync(join(p.dir, 'backlog', 'config.yml'), 'project_name: "demo"\n')
    const store = JSON.parse((await import('node:fs')).readFileSync(p.fb.env.FAKE_BACKLOG_STORE))
    store.config.autoCommit = 'false'
    writeFileSync(p.fb.env.FAKE_BACKLOG_STORE, JSON.stringify(store))
    const r = await p.run(['doctor'])
    assert.match(line(r.out, 'onStatusChange hook'), /^FAIL.*jira-to-backlogmd hook/)
    assert.match(line(r.out, 'autoCommit'), /^FAIL.*recommended/)
  })

  test('invalid configuration skips the Jira checks', async () => {
    const p = healthy({ config: { jira: {} } })
    const r = await p.run(['doctor'])
    assert.match(line(r.out, 'configuration'), /^FAIL.*projectKey/)
    assert.match(line(r.out, 'Jira authentication'), /^FAIL.*skipped/)
    assert.equal(p.jiraCreated.length, 0)
  })

  test('no writes: no Jira issue, task or store file is modified', async () => {
    const p = healthy()
    await p.run(['doctor'])
    assert.deepEqual(p.fake.writes(), [])
    assert.deepEqual(p.fb.writes(), [])
    assert.ok(!existsSync(join(p.dir, STATE_FILE)))
    assert.ok(!existsSync(join(p.dir, '.jira-to-backlogmd', 'lock')))
  })
})
