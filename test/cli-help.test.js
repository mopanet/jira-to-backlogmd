import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const cli = new URL('../src/cli.js', import.meta.url).pathname

test('--help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage: jira-to-backlogmd <command>/)
  for (const cmd of ['init', 'doctor', 'pull', 'push', 'sync', 'hook']) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`))
  }
})
