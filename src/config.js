// Configuration: project file + environment variables (spec: sync-config).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const CONFIG_DIR = '.jira-to-backlogmd'
export const DEFAULT_CONFIG_PATH = `${CONFIG_DIR}/config.json`
export const CONFLICT_STRATEGIES = ['backlog-wins', 'jira-wins', 'skip']
const SECRET_ENV = ['JIRA_BASE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN']
const SECRET_KEY_RE = /^(api[-_]?token|token|password|secret)$/i
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]+$/

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
    this.name = 'ConfigError'
    this.errors = errors
  }
}

/** JSON with `//` and `/* *\/` comments (outside strings) and trailing commas allowed. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) throw new SyntaxError('Unterminated block comment')
      i++
    } else {
      out += c
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function findSecretKeys(value, path, found) {
  if (!isObject(value)) return found
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k
    if (SECRET_KEY_RE.test(k)) found.push(p)
    findSecretKeys(v, p, found)
  }
  return found
}

/**
 * Validate raw config + env. Returns every problem at once; `config` is only
 * meaningful when `errors` is empty.
 */
export function validateConfig(raw, env = process.env) {
  const errors = []
  const cfg = isObject(raw) ? raw : {}
  if (!isObject(raw)) errors.push('config file must contain a JSON object')

  for (const p of findSecretKeys(cfg, '', [])) {
    errors.push(
      `${p}: secrets are not allowed in the config file; set ${SECRET_ENV.join(', ')} in the environment`,
    )
  }
  for (const name of SECRET_ENV) {
    if (!env[name]) errors.push(`environment variable ${name} is not set`)
  }
  if (env.JIRA_BASE_URL && !/^https?:\/\/[^/\s]+/.test(env.JIRA_BASE_URL)) {
    errors.push('environment variable JIRA_BASE_URL must be an http(s) URL')
  }

  const jira = isObject(cfg.jira) ? cfg.jira : {}
  const projectKey = jira.projectKey
  if (typeof projectKey !== 'string' || !PROJECT_KEY_RE.test(projectKey)) {
    errors.push('jira.projectKey is required and must be a Jira project key such as "PROJ"')
  }
  if (jira.jql !== undefined && (typeof jira.jql !== 'string' || !jira.jql.trim())) {
    errors.push('jira.jql must be a non-empty string when set')
  }

  const statusMapping = {}
  if (!isObject(cfg.statusMapping) || Object.keys(cfg.statusMapping).length === 0) {
    errors.push('statusMapping is required: map each Backlog.md status to a list of Jira statuses')
  } else {
    const owner = new Map()
    for (const [backlogStatus, list] of Object.entries(cfg.statusMapping)) {
      const label = `statusMapping[${JSON.stringify(backlogStatus)}]`
      if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === 'string')) {
        errors.push(`${label} must be a non-empty list of Jira status names`)
        continue
      }
      statusMapping[backlogStatus] = list
      for (const jiraStatus of list) {
        const k = jiraStatus.toLowerCase()
        if (owner.has(k) && owner.get(k) !== backlogStatus) {
          errors.push(
            `Jira status ${JSON.stringify(jiraStatus)} is mapped under more than one Backlog.md status (${JSON.stringify(owner.get(k))} and ${JSON.stringify(backlogStatus)})`,
          )
        }
        owner.set(k, backlogStatus)
      }
    }
  }

  const assignees = {}
  if (cfg.assignees !== undefined) {
    if (!isObject(cfg.assignees)) errors.push('assignees must be an object')
    else
      for (const [k, v] of Object.entries(cfg.assignees)) {
        if (typeof v !== 'string' || !v.trim())
          errors.push(`assignees[${JSON.stringify(k)}] must be a non-empty string`)
        else assignees[k.toLowerCase()] = v
      }
  }

  const sync = isObject(cfg.sync) ? cfg.sync : {}
  const conflictStrategy = sync.conflictStrategy ?? 'backlog-wins'
  if (!CONFLICT_STRATEGIES.includes(conflictStrategy)) {
    errors.push(
      `sync.conflictStrategy ${JSON.stringify(conflictStrategy)} is not valid; accepted values: ${CONFLICT_STRATEGIES.join(', ')}`,
    )
  }
  const doneStatus = sync.doneStatus ?? 'Done'
  if (typeof doneStatus !== 'string') errors.push('sync.doneStatus must be a string')
  for (const k of ['lockWaitMs', 'maxRunAgeMs']) {
    if (sync[k] !== undefined && !(Number.isInteger(sync[k]) && sync[k] >= 0))
      errors.push(`sync.${k} must be a non-negative integer`)
  }

  const backlog = isObject(cfg.backlog) ? cfg.backlog : {}
  if (backlog.command !== undefined && typeof backlog.command !== 'string')
    errors.push('backlog.command must be a string')

  const config = {
    jira: {
      baseUrl: (env.JIRA_BASE_URL ?? '').replace(/\/+$/, ''),
      email: env.JIRA_USER_EMAIL,
      token: env.JIRA_API_TOKEN,
      projectKey,
      jql: jira.jql ?? `project = ${projectKey} AND statusCategory != Done ORDER BY created ASC`,
    },
    statusMapping,
    assignees,
    sync: {
      conflictStrategy,
      doneStatus,
      lockWaitMs: sync.lockWaitMs ?? 10_000,
      maxRunAgeMs: sync.maxRunAgeMs ?? 30 * 60_000,
    },
    backlog: { command: backlog.command ?? 'backlog', projectDir: undefined },
  }
  return { config, errors }
}

/** Backlog.md status for a Jira status (case-insensitive), or undefined. */
export function reverseStatus(config, jiraStatus) {
  const k = String(jiraStatus).toLowerCase()
  for (const [backlogStatus, list] of Object.entries(config.statusMapping)) {
    if (list.some((s) => s.toLowerCase() === k)) return backlogStatus
  }
  return undefined
}

/** True when `jiraStatus` is one of the Jira statuses mapped to `backlogStatus`. */
export function isMappedTo(config, backlogStatus, jiraStatus) {
  const list = config.statusMapping[backlogStatus] ?? []
  return list.some((s) => s.toLowerCase() === String(jiraStatus).toLowerCase())
}

/**
 * Read and validate the config file. The Backlog.md project is `projectDir` (the
 * working directory), or `backlog.projectPath` resolved against it.
 */
export function loadConfig({ projectDir, configPath, env = process.env }) {
  const file = resolve(projectDir, configPath ?? DEFAULT_CONFIG_PATH)
  if (!existsSync(file)) {
    throw new ConfigError([`config file not found: ${file} (run "jira-to-backlogmd init")`])
  }
  let raw
  try {
    raw = parseJsonc(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError([`config file ${file} is not valid JSON: ${e.message}`])
  }
  const { config, errors } = validateConfig(raw, env)
  const projectPath = raw?.backlog?.projectPath
  if (projectPath !== undefined && typeof projectPath !== 'string')
    errors.push('backlog.projectPath must be a string')
  if (errors.length) throw new ConfigError(errors)
  config.backlog.projectDir = projectPath ? resolve(projectDir, projectPath) : projectDir
  config.file = file
  return config
}
