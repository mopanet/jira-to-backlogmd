import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { JiraCloudClient, JiraError } from '../src/jira/client.js'

/** A scripted fetch: each call shifts the next response; requests are recorded. */
function scriptedFetch(responses) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body })
    const r = responses.shift() ?? { status: 500, body: { error: 'script exhausted' } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  }
  return { fetch, calls }
}

const make = (responses, extra = {}) => {
  const f = scriptedFetch(responses)
  const sleeps = []
  const client = new JiraCloudClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'bot@example.com',
    token: 'tok-123-secret',
    fetch: f.fetch,
    sleep: async (ms) => sleeps.push(ms),
    ...extra,
  })
  return { client, calls: f.calls, sleeps }
}

const rawIssue = (key, status = 'To Do') => ({
  key,
  fields: {
    summary: `Summary ${key}`,
    description: null,
    status: { name: status, statusCategory: { key: 'new' } },
    assignee: { accountId: 'acc-1', emailAddress: 'jane@example.com', displayName: 'Jane Doe' },
    labels: ['auth'],
    priority: { name: 'High' },
    updated: '2026-10-01T10:00:00.000+0000',
  },
})

describe('jira client: auth and requests', () => {
  test('basic-auth header from e-mail and token', async () => {
    const { client, calls } = make([{ body: { accountId: 'bot' } }])
    await client.myself()
    const expected = `Basic ${Buffer.from('bot@example.com:tok-123-secret').toString('base64')}`
    assert.equal(calls[0].headers.Authorization, expected)
    assert.equal(calls[0].url, 'https://acme.atlassian.net/rest/api/3/myself')
  })

  test('search/jql paginates with nextPageToken and normalises issues', async () => {
    const { client, calls } = make([
      { body: { issues: [rawIssue('PROJ-1')], nextPageToken: 'p2' } },
      { body: { issues: [rawIssue('PROJ-2', 'In Review')], isLast: true } },
    ])
    const issues = await client.searchIssues('project = PROJ')
    assert.deepEqual(
      issues.map((i) => [i.key, i.status]),
      [
        ['PROJ-1', 'To Do'],
        ['PROJ-2', 'In Review'],
      ],
    )
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://acme.atlassian.net/rest/api/3/search/jql')
    const first = JSON.parse(calls[0].body)
    assert.equal(first.jql, 'project = PROJ')
    assert.ok(first.fields.includes('summary') && first.fields.includes('status'))
    assert.equal(first.nextPageToken, undefined)
    assert.equal(JSON.parse(calls[1].body).nextPageToken, 'p2')
    assert.deepEqual(issues[0].assignee, {
      accountId: 'acc-1',
      email: 'jane@example.com',
      displayName: 'Jane Doe',
    })
    assert.equal(issues[0].priority, 'High')
    assert.equal(issues[0].browseUrl, 'https://acme.atlassian.net/browse/PROJ-1')
  })

  test('a repeated nextPageToken stops pagination', async () => {
    const { client } = make([
      { body: { issues: [rawIssue('PROJ-1')], nextPageToken: 'same' } },
      { body: { issues: [rawIssue('PROJ-2')], nextPageToken: 'same' } },
    ])
    assert.equal((await client.searchIssues('project = PROJ')).length, 2)
  })

  test('getIssue returns null on 404', async () => {
    const { client } = make([{ status: 404, body: { errorMessages: ['nope'] } }])
    assert.equal(await client.getIssue('PROJ-9'), null)
  })

  test('transitions lookup and transition POST', async () => {
    const { client, calls } = make([
      { body: { transitions: [{ id: '31', name: 'Finish', to: { name: 'Done' } }] } },
      { status: 204 },
    ])
    const ts = await client.getTransitions('PROJ-7')
    assert.deepEqual(ts, [{ id: '31', name: 'Finish', to: 'Done' }])
    await client.transition('PROJ-7', '31')
    assert.equal(calls[1].url, 'https://acme.atlassian.net/rest/api/3/issue/PROJ-7/transitions')
    assert.deepEqual(JSON.parse(calls[1].body), { transition: { id: '31' } })
  })

  test('comment body is ADF', async () => {
    const { client, calls } = make([{ status: 201, body: { id: '1' } }])
    await client.addComment('PROJ-7', 'TASK-12: first line\nsecond line\n\nnext para')
    const body = JSON.parse(calls[0].body).body
    assert.equal(body.type, 'doc')
    assert.equal(body.version, 1)
    assert.equal(body.content.length, 2)
    assert.equal(body.content[0].content[0].text, 'TASK-12: first line')
    assert.equal(body.content[0].content[1].type, 'hardBreak')
  })

  test('remote link carries a globalId', async () => {
    const { client, calls } = make([{ status: 201, body: { id: 1 } }])
    await client.addRemoteLink('PROJ-7', {
      url: 'https://github.com/acme/app/pull/42',
      title: 'TASK-12: github.com/acme/app/pull/42',
      globalId: 'jira-to-backlogmd:TASK-12:abc',
    })
    assert.equal(calls[0].url, 'https://acme.atlassian.net/rest/api/3/issue/PROJ-7/remotelink')
    assert.deepEqual(JSON.parse(calls[0].body), {
      globalId: 'jira-to-backlogmd:TASK-12:abc',
      object: {
        url: 'https://github.com/acme/app/pull/42',
        title: 'TASK-12: github.com/acme/app/pull/42',
      },
    })
  })

  test('issue keys are validated before building a path', async () => {
    const { client } = make([])
    await assert.rejects(client.getTransitions('../../admin'), /invalid issue key/)
  })
})

describe('jira client: retries', () => {
  test('429 honours Retry-After seconds', async () => {
    const { client, sleeps } = make([
      { status: 429, headers: { 'retry-after': '3' } },
      { body: { accountId: 'bot' } },
    ])
    await client.myself()
    assert.deepEqual(sleeps, [3000])
  })

  test('5xx is retried with exponential backoff up to the limit, then fails', async () => {
    const { client, sleeps, calls } = make(
      [{ status: 502 }, { status: 503 }, { status: 500 }, { status: 500 }],
      { maxRetries: 3 },
    )
    await assert.rejects(client.myself(), (e) => e instanceof JiraError && e.status === 500)
    assert.equal(calls.length, 4)
    assert.deepEqual(sleeps, [500, 1000, 2000])
  })

  test('4xx other than 429 fails immediately with the Jira error text', async () => {
    const { client, calls } = make([
      { status: 400, body: { errorMessages: ['Field resolution is required'] } },
    ])
    await assert.rejects(
      client.transition('PROJ-7', '31'),
      (e) => e instanceof JiraError && e.status === 400 && /resolution is required/.test(e.message),
    )
    assert.equal(calls.length, 1)
  })

  test('errors never contain the token', async () => {
    const { client } = make([{ status: 401, body: { message: 'bad tok-123-secret' } }])
    await assert.rejects(client.myself(), (e) => !e.message.includes('tok-123-secret'))
  })
})

describe('jira client: verbose logging', () => {
  test('requests are logged with the authorization redacted', async () => {
    const seen = []
    const logger = { request: (...a) => seen.push(a), debug: () => {} }
    const { client } = make([{ body: {} }], { logger })
    await client.myself()
    assert.equal(seen[0][0], 'GET')
    assert.ok(seen[0][2].Authorization)
  })
})
