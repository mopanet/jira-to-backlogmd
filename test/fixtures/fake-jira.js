// In-memory Jira for sync tests (invented data only), plus a fetch emulator so the
// Cloud client can run the same interface tests against it.
import { JiraError } from '../../src/jira/client.js'

const BASE = 'https://acme.atlassian.net'
let clock = Date.parse('2026-10-01T10:00:00Z')
const tick = () => new Date((clock += 60_000)).toISOString().replace('Z', '+0000')

export function makeIssue(key, over = {}) {
  return {
    key,
    summary: `Summary of ${key}`,
    description: null,
    status: 'To Do',
    statusCategory: 'new',
    assignee: null,
    labels: [],
    priority: null,
    updated: tick(),
    browseUrl: `${BASE}/browse/${key}`,
    ...over,
  }
}

export class FakeJiraClient {
  /**
   * @param issues    normalised issues (see makeIssue)
   * @param statuses  all workflow statuses; transitions go from any status to any other
   * @param workflow  optional {fromStatus: [toStatus...]} restricting transitions
   * @param fail      {method: [issueKey...]} -> that call throws HTTP 400
   */
  constructor({
    issues = [],
    statuses = ['To Do', 'In Progress', 'In Review', 'Blocked', 'Done'],
    workflow,
    fail = {},
    baseUrl = BASE,
  } = {}) {
    this.baseUrl = baseUrl
    this.issues = new Map(issues.map((i) => [i.key, structuredClone(i)]))
    this.statuses = statuses
    this.workflow = workflow
    this.fail = fail
    this.outOfScope = new Set()
    this.calls = []
    this.transitions = []
    this.comments = []
    this.remoteLinks = new Map()
  }

  check(method, key) {
    this.calls.push({ method, key })
    if (this.fail[method]?.includes(key)) {
      throw new JiraError(`${method} ${key} -> HTTP 400: simulated failure`, { status: 400 })
    }
  }

  issue(key) {
    return this.issues.get(key)
  }

  setStatus(key, status) {
    Object.assign(this.issues.get(key), { status, updated: tick() })
  }

  update(key, fields) {
    Object.assign(this.issues.get(key), fields, { updated: tick() })
  }

  async myself() {
    this.check('myself')
    return { accountId: 'bot', displayName: 'Sync Bot' }
  }

  async getProject(key) {
    this.check('getProject', key)
    return { key }
  }

  async searchIssues(_jql) {
    this.check('searchIssues')
    return [...this.issues.values()]
      .filter((i) => !this.outOfScope.has(i.key))
      .map((i) => structuredClone(i))
  }

  async getIssue(key) {
    this.check('getIssue', key)
    const i = this.issues.get(key)
    return i ? structuredClone(i) : null
  }

  async getTransitions(key) {
    this.check('getTransitions', key)
    const from = this.issues.get(key).status
    const targets = this.workflow?.[from] ?? this.statuses.filter((s) => s !== from)
    return targets.map((to) => ({ id: `t-${to}`, name: `Move to ${to}`, to }))
  }

  async transition(key, transitionId) {
    this.check('transition', key)
    const to = String(transitionId).replace(/^t-/, '')
    const available = await this.getTransitions(key)
    this.calls.pop()
    if (!available.some((t) => t.id === transitionId)) {
      throw new JiraError(`transition ${transitionId} not available`, { status: 400 })
    }
    this.transitions.push({ key, to })
    this.setStatus(key, to)
  }

  async addComment(key, text) {
    this.check('addComment', key)
    this.comments.push({ key, text })
  }

  async addRemoteLink(key, { url, title, globalId }) {
    this.check('addRemoteLink', key)
    if (!this.remoteLinks.has(key)) this.remoteLinks.set(key, new Map())
    this.remoteLinks.get(key).set(globalId, { url, title })
  }

  /** Remote links of an issue as an array. */
  links(key) {
    return [...(this.remoteLinks.get(key)?.values() ?? [])]
  }

  /** Calls that change Jira. */
  writes() {
    return this.calls.filter((c) =>
      ['transition', 'addComment', 'addRemoteLink'].includes(c.method),
    )
  }
}

const toRaw = (i) => ({
  key: i.key,
  fields: {
    summary: i.summary,
    description: i.description,
    status: { name: i.status, statusCategory: { key: i.statusCategory } },
    assignee: i.assignee && {
      accountId: i.assignee.accountId,
      emailAddress: i.assignee.email,
      displayName: i.assignee.displayName,
    },
    labels: i.labels,
    priority: i.priority && { name: i.priority },
    updated: i.updated,
  },
})

const adfText = (doc) =>
  (doc.content ?? [])
    .map((p) => (p.content ?? []).map((n) => (n.type === 'hardBreak' ? '\n' : n.text)).join(''))
    .join('\n\n')

/** A `fetch` that serves the Jira Cloud REST v3 subset the client uses from a FakeJiraClient. */
export function fakeJiraFetch(fake) {
  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  return async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(url).pathname.replace('/rest/api/3', '')
    const body = init.body ? JSON.parse(init.body) : undefined
    try {
      if (path === '/myself') return json(200, await fake.myself())
      if (path.startsWith('/project/')) return json(200, await fake.getProject(path.slice(9)))
      if (path === '/search/jql') {
        return json(200, { issues: (await fake.searchIssues(body.jql)).map(toRaw), isLast: true })
      }
      const m = path.match(/^\/issue\/([^/]+)(?:\/(\w+))?$/)
      if (m) {
        const [, key, sub] = m
        if (!sub) {
          const i = await fake.getIssue(key)
          return i ? json(200, toRaw(i)) : json(404, { errorMessages: ['Issue does not exist'] })
        }
        if (sub === 'transitions' && method === 'GET') {
          const ts = await fake.getTransitions(key)
          return json(200, {
            transitions: ts.map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })),
          })
        }
        if (sub === 'transitions') {
          await fake.transition(key, body.transition.id)
          return json(204)
        }
        if (sub === 'comment') {
          await fake.addComment(key, adfText(body.body))
          return json(201, { id: '1' })
        }
        if (sub === 'remotelink') {
          await fake.addRemoteLink(key, { ...body.object, globalId: body.globalId })
          return json(201, { id: 1 })
        }
      }
      return json(404, { errorMessages: [`no route ${method} ${path}`] })
    } catch (e) {
      return json(e.status ?? 500, { errorMessages: [e.message] })
    }
  }
}
