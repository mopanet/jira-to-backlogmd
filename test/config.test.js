import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  ConfigError,
  loadConfig,
  parseJsonc,
  reverseStatus,
  validateConfig,
} from '../src/config.js'

const ENV = {
  JIRA_BASE_URL: 'https://acme.atlassian.net',
  JIRA_USER_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'tok-123-secret',
}

const base = () => ({
  jira: { projectKey: 'PROJ' },
  statusMapping: {
    'To Do': ['To Do'],
    'In Progress': ['In Progress', 'In Review'],
    Done: ['Done', 'Closed'],
  },
})

const errorsOf = (raw, env = ENV) => validateConfig(raw, env).errors

describe('sync-config: loading', () => {
  test('valid file and environment produce the merged configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-cfg-'))
    mkdirSync(join(dir, '.jira-to-backlogmd'))
    writeFileSync(
      join(dir, '.jira-to-backlogmd', 'config.json'),
      `// comment line\n${JSON.stringify(base())}`,
    )
    const cfg = loadConfig({ projectDir: dir, env: ENV })
    assert.equal(cfg.jira.baseUrl, 'https://acme.atlassian.net')
    assert.equal(cfg.jira.email, 'bot@example.com')
    assert.equal(cfg.jira.token, 'tok-123-secret')
    assert.equal(cfg.jira.projectKey, 'PROJ')
    assert.equal(cfg.backlog.projectDir, dir)
  })

  test('--config overrides the default path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-cfg-'))
    const file = join(dir, 'other.json')
    writeFileSync(file, JSON.stringify(base()))
    const cfg = loadConfig({ projectDir: dir, configPath: file, env: ENV })
    assert.equal(cfg.jira.projectKey, 'PROJ')
  })

  test('a missing config file is a configuration error naming the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-cfg-'))
    assert.throws(
      () => loadConfig({ projectDir: dir, env: ENV }),
      (e) => e instanceof ConfigError && /config\.json/.test(e.message),
    )
  })

  test('missing secret names the variable and prints no other secret', () => {
    const { JIRA_API_TOKEN: _, ...env } = ENV
    const errors = errorsOf(base(), env)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /JIRA_API_TOKEN/)
    assert.ok(!errors.join().includes('bot@example.com'))
  })

  for (const key of ['apiToken', 'token', 'password']) {
    test(`secret key "${key}" in the config file is rejected`, () => {
      const raw = base()
      raw.jira[key] = 'x'
      const errors = errorsOf(raw)
      assert.ok(errors.some((e) => e.includes(`jira.${key}`) && /environment/.test(e)))
    })
  }

  test('JSONC comments are stripped but strings containing // survive', () => {
    const parsed = parseJsonc('{\n  // a comment\n  "url": "https://x.example/a" /* block */\n}')
    assert.deepEqual(parsed, { url: 'https://x.example/a' })
  })
})

describe('sync-config: project selection', () => {
  test('default JQL', () => {
    const { config } = validateConfig(base(), ENV)
    assert.equal(config.jira.jql, 'project = PROJ AND statusCategory != Done ORDER BY created ASC')
  })

  test('custom JQL is kept', () => {
    const raw = base()
    raw.jira.jql = 'project = PROJ AND labels = sync'
    assert.equal(validateConfig(raw, ENV).config.jira.jql, 'project = PROJ AND labels = sync')
  })

  test('invalid project key is reported', () => {
    const raw = base()
    raw.jira.projectKey = 'proj key'
    assert.ok(errorsOf(raw).some((e) => e.includes('jira.projectKey')))
  })
})

describe('sync-config: status mapping', () => {
  test('import accepts a secondary Jira status', () => {
    const { config } = validateConfig(base(), ENV)
    assert.equal(reverseStatus(config, 'In Review'), 'In Progress')
    assert.equal(reverseStatus(config, 'in review'), 'In Progress')
  })

  test('write-back target is the first entry', () => {
    const { config } = validateConfig(base(), ENV)
    assert.equal(config.statusMapping.Done[0], 'Done')
  })

  test('unmapped Jira status resolves to undefined', () => {
    const { config } = validateConfig(base(), ENV)
    assert.equal(reverseStatus(config, 'Blocked'), undefined)
  })

  test('duplicate Jira status across entries fails and names it', () => {
    const raw = base()
    raw.statusMapping['In Progress'].push('Done')
    const errors = errorsOf(raw)
    assert.ok(errors.some((e) => e.includes('"Done"') && /more than one/.test(e)))
  })

  test('empty list fails', () => {
    const raw = base()
    raw.statusMapping['To Do'] = []
    assert.ok(errorsOf(raw).some((e) => e.includes('statusMapping["To Do"]')))
  })
})

describe('sync-config: assignees', () => {
  test('mapping is kept with case-insensitive e-mail keys', () => {
    const raw = base()
    raw.assignees = { 'Jane@Example.com': '@jane' }
    const { config, errors } = validateConfig(raw, ENV)
    assert.deepEqual(errors, [])
    assert.equal(config.assignees['jane@example.com'], '@jane')
  })

  test('non-string assignee values fail', () => {
    const raw = base()
    raw.assignees = { 'jane@example.com': 3 }
    assert.ok(errorsOf(raw).some((e) => e.includes('assignees')))
  })
})

describe('sync-config: conflict strategy', () => {
  test('default strategy is backlog-wins', () => {
    assert.equal(validateConfig(base(), ENV).config.sync.conflictStrategy, 'backlog-wins')
  })

  test('unknown strategy lists the accepted values', () => {
    const raw = base()
    raw.sync = { conflictStrategy: 'latest' }
    const errors = errorsOf(raw)
    assert.ok(errors.some((e) => /backlog-wins, jira-wins, skip/.test(e)))
  })
})

describe('sync-config: aggregated validation', () => {
  test('several errors are reported at once', () => {
    const raw = base()
    delete raw.jira.projectKey
    raw.sync = { conflictStrategy: 'latest' }
    const errors = errorsOf(raw)
    assert.ok(errors.some((e) => e.includes('jira.projectKey')))
    assert.ok(errors.some((e) => e.includes('sync.conflictStrategy')))
  })

  test('loadConfig throws one ConfigError carrying every message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j2b-cfg-'))
    const file = join(dir, 'c.json')
    writeFileSync(file, JSON.stringify({ sync: { conflictStrategy: 'latest' } }))
    assert.throws(
      () => loadConfig({ projectDir: dir, configPath: file, env: {} }),
      (e) => e instanceof ConfigError && e.errors.length >= 5,
    )
  })
})

describe('sync-config: init template', () => {
  test('the default template loads with zero validation errors', () => {
    const text = readFileSync(new URL('../src/templates/config.json', import.meta.url), 'utf8')
    const { errors, config } = validateConfig(parseJsonc(text), ENV)
    assert.deepEqual(errors, [])
    assert.equal(config.sync.conflictStrategy, 'backlog-wins')
  })
})
