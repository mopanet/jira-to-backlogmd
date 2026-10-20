// `init`: scaffold the config file and git-ignore the lock (spec: sync-cli).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_DIR, DEFAULT_CONFIG_PATH } from './config.js'

const TEMPLATE = new URL('./templates/config.json', import.meta.url)
const IGNORE_LINES = [`${CONFIG_DIR}/lock`, `${CONFIG_DIR}/*.tmp`]

export function runInit({ projectDir, configPath, log }) {
  const file = resolve(projectDir, configPath ?? DEFAULT_CONFIG_PATH)
  if (existsSync(file)) {
    log.out(`config already exists at ${file}; left unchanged`)
  } else {
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(TEMPLATE, file)
    log.out(`created ${file}: set jira.projectKey and review statusMapping`)
  }

  const ignore = join(projectDir, '.gitignore')
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()))
  const missing = IGNORE_LINES.filter((l) => !present.has(l))
  if (missing.length) {
    const sep = current && !current.endsWith('\n') ? '\n' : ''
    appendFileSync(ignore, `${sep}${missing.join('\n')}\n`)
    log.out(`added ${missing.join(', ')} to ${ignore}`)
  }
  log.out(
    'next: export JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, then run "jira-to-backlogmd doctor"',
  )
  return 0
}
