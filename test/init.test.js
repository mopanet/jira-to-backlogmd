import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { main } from '../src/cli.js'
import { parseJsonc } from '../src/config.js'

async function run(dir, argv = ['init']) {
  const out = []
  const err = []
  const code = await main(argv, {
    cwd: dir,
    env: {},
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  })
  return { code, out: out.join(''), err: err.join('') }
}

describe('sync-cli: init', () => {
  test('fresh project: config with default mapping and the lock path git-ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-init-'))
    const r = await run(dir)
    assert.equal(r.code, 0, r.err)
    const cfg = parseJsonc(readFileSync(join(dir, '.jira-to-backlogmd/config.json'), 'utf8'))
    assert.deepEqual(cfg.statusMapping['In Progress'], ['In Progress', 'In Review'])
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.match(ignore, /^\.jira-to-backlogmd\/lock$/m)
    assert.match(r.out, /created/)
  })

  test('an existing .gitignore is appended to once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-init-'))
    writeFileSync(join(dir, '.gitignore'), 'node_modules/')
    await run(dir)
    await run(dir)
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    assert.equal(ignore, 'node_modules/\n.jira-to-backlogmd/lock\n.jira-to-backlogmd/*.tmp\n')
  })

  test('existing config is left unchanged and the command says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-init-'))
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(join(dir, '.jira-to-backlogmd/config.json'), '{"mine":true}')
    const r = await run(dir)
    assert.equal(r.code, 0)
    assert.equal(readFileSync(join(dir, '.jira-to-backlogmd/config.json'), 'utf8'), '{"mine":true}')
    assert.match(r.out, /already exists.*unchanged/)
  })
})
