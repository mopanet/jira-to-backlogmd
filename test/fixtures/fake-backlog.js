// Test helper around the fake `backlog` executable in ./bin.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FAKE_BACKLOG = new URL('./bin/backlog', import.meta.url).pathname

/** A fresh fake Backlog.md project: `env` to pass to BacklogCli, plus store/log accessors. */
export function fakeBacklog({ tasks = [], config = { autoCommit: 'true' }, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'j2b-backlog-'))
  const store = join(dir, 'store.json')
  const log = join(dir, 'calls.jsonl')
  const nextId = tasks.reduce((n, t) => Math.max(n, Number(t.id.split('-')[1]) + 1), 1)
  writeFileSync(store, JSON.stringify({ nextId, tasks, config, ...extra }))
  return {
    dir,
    env: { ...process.env, FAKE_BACKLOG_STORE: store, FAKE_BACKLOG_LOG: log },
    tasks: () => JSON.parse(readFileSync(store, 'utf8')).tasks,
    task: (id) => JSON.parse(readFileSync(store, 'utf8')).tasks.find((t) => t.id === id),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [],
    writes: function () {
      return this.calls().filter(
        (c) => c.argv[0] === 'task' && ['create', 'edit'].includes(c.argv[1]),
      )
    },
  }
}

/** A Backlog.md task as `task view --json` returns it, with test defaults. */
export function makeTask(overrides) {
  return {
    id: 'TASK-1',
    title: 'Untitled',
    status: 'To Do',
    archived: false,
    priority: null,
    assignees: [],
    labels: [],
    references: [],
    description: null,
    implementationPlan: null,
    acceptanceCriteria: [],
    finalSummary: null,
    ...overrides,
  }
}
