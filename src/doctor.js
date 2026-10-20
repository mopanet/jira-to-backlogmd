// `doctor`: read-only environment checks (spec: sync-cli).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseJsonc } from './config.js'

export const SUPPORTED_BACKLOG = { min: '1.54.0', belowMajor: 2 }
const BACKLOG_CONFIG_FILES = ['backlog/config.yml', '.backlog/config.yml', 'backlog.config.yml']
const SCOPE_HINT =
  'required: classic scopes read:jira-work + write:jira-work (or the bot user needs Browse Projects and Transition Issues permissions)'

const parseVersion = (v) =>
  String(v)
    .match(/(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number)

export function backlogVersionSupported(version) {
  const v = parseVersion(version)
  const min = parseVersion(SUPPORTED_BACKLOG.min)
  if (!v) return false
  if (v[0] >= SUPPORTED_BACKLOG.belowMajor) return false
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]
  return true
}

function readBacklogConfig(projectDir) {
  for (const rel of BACKLOG_CONFIG_FILES) {
    const file = join(projectDir, rel)
    if (existsSync(file)) return { file, text: readFileSync(file, 'utf8') }
  }
  return null
}

/** Print one PASS/FAIL line per check; returns true when every check passed. */
export async function runDoctor({ projectDir, configPath, env, log, createJira, createBacklog }) {
  const results = []
  const check = (name, ok, detail) => {
    results.push(ok)
    log.out(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  }

  let config
  let configProblem
  try {
    config = loadConfig({ projectDir, configPath, env })
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    configProblem = e.errors.join('; ')
  }
  // Even with an invalid config, honour backlog.command if the file parses.
  let command = config?.backlog.command
  if (!command) {
    try {
      const file = join(projectDir, configPath ?? '.jira-to-backlogmd/config.json')
      command = parseJsonc(readFileSync(file, 'utf8'))?.backlog?.command
    } catch {
      // unreadable: fall back to "backlog" on PATH
    }
  }
  const backlog = createBacklog(
    {
      backlog: {
        command: command ?? 'backlog',
        projectDir: config?.backlog.projectDir ?? projectDir,
      },
    },
    env,
  )

  try {
    const version = await backlog.version()
    check(
      'backlog CLI',
      backlogVersionSupported(version),
      `${version} (supported: >=${SUPPORTED_BACKLOG.min} <${SUPPORTED_BACKLOG.belowMajor})`,
    )
  } catch (e) {
    check(
      'backlog CLI',
      false,
      `not runnable (${e.message}); install backlog.md or set backlog.command`,
    )
  }

  try {
    await backlog.configGet('projectName')
    check('Backlog.md project', true, `initialised in ${config?.backlog.projectDir ?? projectDir}`)
  } catch (e) {
    check('Backlog.md project', false, `not initialised (${e.message}); run "backlog init"`)
  }

  check('configuration', !configProblem, configProblem ?? `valid (${config.file})`)

  if (!config) {
    check('Jira authentication', false, 'skipped: configuration invalid')
    check('Jira project access', false, 'skipped: configuration invalid')
  } else {
    const jira = createJira(config, log)
    let authed = false
    try {
      const me = await jira.myself()
      authed = true
      check(
        'Jira authentication',
        true,
        `${config.jira.baseUrl} as ${me?.displayName ?? me?.accountId ?? 'unknown'}`,
      )
    } catch (e) {
      check(
        'Jira authentication',
        false,
        `${e.message} (check JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN)`,
      )
    }
    if (!authed) check('Jira project access', false, 'skipped: authentication failed')
    else {
      const key = config.jira.projectKey
      try {
        await jira.getProject(key)
        const [issue] = await jira.searchIssues(`project = ${key} ORDER BY created DESC`, {
          limit: 1,
        })
        if (!issue)
          check('Jira project access', true, `${key} readable (no issues to list transitions on)`)
        else {
          let transitions
          try {
            transitions = await jira.getTransitions(issue.key)
          } catch (e) {
            transitions = e
          }
          if (transitions instanceof Error || transitions.length === 0) {
            const why =
              transitions instanceof Error ? transitions.message : 'no transitions offered'
            check(
              'Jira project access',
              false,
              `${key} readable but transitions on ${issue.key} refused (${why}); ${SCOPE_HINT}`,
            )
          } else {
            check(
              'Jira project access',
              true,
              `${key} readable, ${transitions.length} transitions on ${issue.key}`,
            )
          }
        }
      } catch (e) {
        check(
          'Jira project access',
          false,
          `cannot read project ${key} (${e.message}); ${SCOPE_HINT}`,
        )
      }
    }
  }

  const bc = readBacklogConfig(config?.backlog.projectDir ?? projectDir)
  const hook = bc?.text.match(/^onStatusChange:\s*(.+)$/m)?.[1]?.trim()
  check(
    'onStatusChange hook',
    Boolean(hook && /jira-to-backlogmd\b.*\bhook\b/.test(hook)),
    hook
      ? `${bc.file}: ${hook}`
      : `not set; add  onStatusChange: 'jira-to-backlogmd hook'  to ${bc?.file ?? 'backlog/config.yml'}`,
  )

  try {
    const autoCommit = await backlog.configGet('autoCommit')
    check(
      'autoCommit',
      autoCommit === 'true',
      autoCommit === 'true'
        ? 'enabled'
        : `is "${autoCommit}"; recommended: backlog config set autoCommit true (otherwise every sync leaves uncommitted task files)`,
    )
  } catch (e) {
    check('autoCommit', false, `cannot read (${e.message})`)
  }

  return results.every(Boolean)
}
