// Jira client interface + Jira Cloud REST v3 implementation (design D10).
//
// Interface (also implemented by test/fixtures/fake-jira.js):
//   myself(), getProject(key), searchIssues(jql, {limit}), getIssue(key), getTransitions(key),
//   transition(key, transitionId), addComment(key, text), addRemoteLink(key, {url, title, globalId})
// Issues are normalised to:
//   { key, summary, description (ADF|null), status, statusCategory, assignee
//     ({accountId, email, displayName}|null), labels, priority (name|null), updated, browseUrl }

export const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'labels',
  'priority',
  'updated',
]
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/
const MAX_PAGES = 1000

export class JiraError extends Error {
  constructor(message, { status, method, path } = {}) {
    super(message)
    this.name = 'JiraError'
    this.status = status
    this.method = method
    this.path = path
  }
}

const checkKey = (key) => {
  if (!KEY_RE.test(String(key))) throw new JiraError(`invalid issue key ${JSON.stringify(key)}`)
  return key
}

/** Plain text -> ADF: blank lines split paragraphs, single newlines become hard breaks. */
export function textToAdf(text) {
  const paragraphs = String(text)
    .split(/\n{2,}/)
    .map((para) => para.split('\n'))
    .filter((lines) => lines.some((l) => l !== ''))
    .map((lines) => ({
      type: 'paragraph',
      content: lines.flatMap((line, i) => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
    }))
  return { type: 'doc', version: 1, content: paragraphs }
}

export function normaliseIssue(raw, baseUrl) {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    summary: f.summary ?? '',
    description: f.description ?? null,
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? null,
    assignee: f.assignee
      ? {
          accountId: f.assignee.accountId ?? null,
          email: f.assignee.emailAddress ?? null,
          displayName: f.assignee.displayName ?? '',
        }
      : null,
    labels: f.labels ?? [],
    priority: f.priority?.name ?? null,
    updated: f.updated ?? null,
    browseUrl: `${baseUrl}/browse/${raw.key}`,
  }
}

export class JiraCloudClient {
  constructor({
    baseUrl,
    email,
    token,
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    logger,
    maxRetries = 4,
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    this.secrets = [token, this.auth.slice(6)]
    this.fetch = fetch
    this.sleep = sleep
    this.logger = logger
    this.maxRetries = maxRetries
  }

  scrub(text) {
    let s = String(text)
    for (const secret of this.secrets) s = s.split(secret).join('***')
    return s
  }

  async request(method, path, body) {
    const url = `${this.baseUrl}/rest/api/3${path}`
    const headers = { Authorization: this.auth, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    for (let attempt = 0; ; attempt++) {
      this.logger?.request(method, url, headers)
      let res
      try {
        res = await this.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        throw new JiraError(`${method} ${path} failed: ${this.scrub(e.message)}`, { method, path })
      }
      if (res.ok) {
        const text = await res.text()
        return text ? JSON.parse(text) : null
      }
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await this.sleep(
          res.status === 429 && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt,
        )
        continue
      }
      const detail = await res.text().catch(() => '')
      let reason = detail
      try {
        const j = JSON.parse(detail)
        reason = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {}), j.message]
          .filter(Boolean)
          .join('; ')
      } catch {
        // non-JSON error body: keep the raw text
      }
      throw new JiraError(
        `${method} ${path} -> HTTP ${res.status}${reason ? `: ${this.scrub(reason).slice(0, 500)}` : ''}`,
        { status: res.status, method, path },
      )
    }
  }

  myself() {
    return this.request('GET', '/myself')
  }

  getProject(key) {
    return this.request('GET', `/project/${encodeURIComponent(key)}`)
  }

  async searchIssues(jql, { limit = Number.POSITIVE_INFINITY } = {}) {
    const issues = []
    const seen = new Set()
    let nextPageToken
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request('POST', '/search/jql', {
        jql,
        fields: ISSUE_FIELDS,
        maxResults: Math.min(100, limit),
        ...(nextPageToken && { nextPageToken }),
      })
      for (const raw of res?.issues ?? []) issues.push(normaliseIssue(raw, this.baseUrl))
      nextPageToken = res?.nextPageToken
      // isLast is unreliable in practice: also stop on a missing or repeated token.
      if (issues.length >= limit) return issues.slice(0, limit)
      if (res?.isLast || !nextPageToken || seen.has(nextPageToken)) break
      seen.add(nextPageToken)
    }
    return issues
  }

  async getIssue(key) {
    try {
      const raw = await this.request('GET', `/issue/${checkKey(key)}?fields=${ISSUE_FIELDS}`)
      return normaliseIssue(raw, this.baseUrl)
    } catch (e) {
      if (e instanceof JiraError && e.status === 404) return null
      throw e
    }
  }

  async getTransitions(key) {
    const res = await this.request('GET', `/issue/${checkKey(key)}/transitions`)
    return (res?.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? '' }))
  }

  async transition(key, transitionId) {
    await this.request('POST', `/issue/${checkKey(key)}/transitions`, {
      transition: { id: String(transitionId) },
    })
  }

  async addComment(key, text) {
    await this.request('POST', `/issue/${checkKey(key)}/comment`, { body: textToAdf(text) })
  }

  async addRemoteLink(key, { url, title, globalId }) {
    await this.request('POST', `/issue/${checkKey(key)}/remotelink`, {
      globalId,
      object: { url, title },
    })
  }
}
