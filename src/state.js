// Sync state store + run lock (spec: sync-state, design D3/D5).

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from './config.js'

export const STATE_FILE = `${CONFIG_DIR}/state.json`
export const LOCK_FILE = `${CONFIG_DIR}/lock`

export class StateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StateError'
  }
}

export class LockError extends Error {
  constructor(message, holder) {
    super(message)
    this.name = 'LockError'
    this.holder = holder
  }
}

const STRING_FIELDS = ['taskId', 'issueKey', 'lastBacklogStatus', 'lastJiraStatus']
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/

function normalise(r) {
  return {
    taskId: r.taskId,
    issueKey: r.issueKey,
    lastBacklogStatus: r.lastBacklogStatus,
    lastJiraStatus: r.lastJiraStatus,
    jiraUpdated: r.jiraUpdated ?? null,
    linkedUrls: [...(r.linkedUrls ?? [])],
    summaryPosted: Boolean(r.summaryPosted),
  }
}

const issueOrder = (a, b) => {
  const [pa, na] = a.issueKey.split('-')
  const [pb, nb] = b.issueKey.split('-')
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb)
}

class State {
  constructor(file, records) {
    this.file = file
    this.links = new Map(records.map((r) => [r.issueKey, normalise(r)]))
  }

  get(issueKey) {
    return this.links.get(issueKey)
  }

  byTask(taskId) {
    const id = String(taskId).toLowerCase()
    for (const r of this.links.values()) if (r.taskId.toLowerCase() === id) return r
    return undefined
  }

  all() {
    return [...this.links.values()].sort(issueOrder)
  }

  set(record) {
    const r = normalise(record)
    this.links.set(r.issueKey, r)
    return r
  }

  /** Write via temp file + fsync + rename, so a crash leaves old or new content, never half. */
  save({ beforeRename } = {}) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const text = `${JSON.stringify({ version: 1, links: this.all() }, null, 2)}\n`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      beforeRename?.()
      renameSync(tmp, this.file)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }
}

export function loadState(projectDir) {
  const file = join(projectDir, STATE_FILE)
  if (!existsSync(file)) return new State(file, [])
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new StateError(`sync state ${file} is corrupt (${e.message}); fix or restore it from git`)
  }
  const valid =
    data?.version === 1 &&
    Array.isArray(data.links) &&
    data.links.every((r) => STRING_FIELDS.every((k) => typeof r?.[k] === 'string'))
  if (!valid) throw new StateError(`sync state ${file} is corrupt (unexpected structure)`)
  const seen = new Set()
  for (const r of data.links) {
    // Ids are passed to the backlog CLI as arguments: never let one look like an option.
    if (r.taskId.startsWith('-') || !ISSUE_KEY_RE.test(r.issueKey)) {
      throw new StateError(`sync state ${file} is corrupt (invalid link ${r.taskId} ${r.issueKey})`)
    }
    for (const k of [`task:${r.taskId.toLowerCase()}`, `issue:${r.issueKey}`]) {
      if (seen.has(k)) {
        throw new StateError(`sync state ${file} is corrupt (duplicate ${k.replace(':', ' ')})`)
      }
      seen.add(k)
    }
  }
  return new State(file, data.links)
}

/** Split records into those whose task exists and dangling ones (task deleted locally). */
export async function resolveLinkedTasks(records, viewTask) {
  const resolved = []
  const dangling = []
  for (const record of records) {
    const task = await viewTask(record.taskId)
    if (task) resolved.push({ record, task })
    else dangling.push(record)
  }
  return { resolved, dangling }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Remove the lock only while it is still ours (it may have been taken over as stale).
function releaseIfOwned(file, token) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file, { force: true })
  } catch {
    // already gone or replaced by an unreadable lock that is not ours
  }
}

const TAKEOVER_STALE_MS = 10_000

/**
 * Remove a lock judged stale. Takeovers are serialised by a second O_EXCL file, and the lock
 * is removed only if it still has exactly the content that was judged stale, so a fresh lock
 * written meanwhile is never deleted. (Residual window: an owner releasing and a new run
 * re-creating the lock between the re-read and the unlink, i.e. microseconds.)
 */
function takeOverStale(file, judged) {
  const mutex = `${file}.takeover`
  let fd
  try {
    fd = openSync(mutex, 'wx')
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    try {
      // A takeover that crashed leaves its mutex behind: clear it once it is clearly old.
      if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) rmSync(mutex, { force: true })
    } catch {
      // vanished meanwhile
    }
    return
  }
  try {
    closeSync(fd)
    let current
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      return // already gone: the next O_EXCL attempt decides
    }
    if (judged !== undefined && current === judged) rmSync(file, { force: true })
  } finally {
    rmSync(mutex, { force: true })
  }
}

/**
 * Exclusive run lock: O_EXCL create of a file holding pid + start time. Waits up to
 * `waitMs`; a lock whose pid is dead or that is older than `maxAgeMs` is taken over.
 */
export async function acquireLock(
  projectDir,
  { waitMs = 10_000, maxAgeMs = 30 * 60_000, pollMs = 200, isAlive = pidAlive } = {},
) {
  const file = join(projectDir, LOCK_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(file, 'wx')
      const token = randomUUID()
      const body = {
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        token,
      }
      writeSync(fd, JSON.stringify(body))
      closeSync(fd)
      return { file, release: () => releaseIfOwned(file, token) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    let holder = {}
    let since
    let raw
    try {
      raw = readFileSync(file, 'utf8')
      holder = JSON.parse(raw)
      since = Date.parse(holder.startedAt)
    } catch {
      // Unreadable or half-written lock (its creator may still be writing): age by mtime.
    }
    if (!Number.isFinite(since)) {
      try {
        since = statSync(file).mtimeMs
      } catch {
        continue // vanished between open and stat: retry immediately
      }
    }
    const stale =
      (Number.isInteger(holder.pid) && !isAlive(holder.pid)) || Date.now() - since > maxAgeMs
    if (stale) {
      takeOverStale(file, raw)
      continue
    }
    if (Date.now() >= deadline) {
      throw new LockError(
        `another jira-to-backlogmd run holds the lock ${file} (pid ${holder.pid ?? 'unknown'}, started ${holder.startedAt ?? 'unknown'})`,
        holder,
      )
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
  }
}
