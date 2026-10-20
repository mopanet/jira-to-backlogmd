import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { JiraCloudClient } from '../src/jira/client.js'
import { FakeJiraClient, fakeJiraFetch, makeIssue } from './fixtures/fake-jira.js'

const METHODS = [
  'myself',
  'getProject',
  'searchIssues',
  'getIssue',
  'getTransitions',
  'transition',
  'addComment',
  'addRemoteLink',
]

const seed = () =>
  new FakeJiraClient({
    issues: [
      makeIssue('PROJ-1', {
        labels: ['auth'],
        priority: 'High',
        assignee: { accountId: 'a1', email: 'jane@example.com', displayName: 'Jane Doe' },
      }),
      makeIssue('PROJ-2', { status: 'In Progress' }),
    ],
  })

const implementations = {
  FakeJiraClient: () => {
    const fake = seed()
    return { client: fake, fake }
  },
  JiraCloudClient: () => {
    const fake = seed()
    const client = new JiraCloudClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@example.com',
      token: 'x-token',
      fetch: fakeJiraFetch(fake),
      sleep: async () => {},
      maxRetries: 0,
    })
    return { client, fake }
  },
}

for (const [name, make] of Object.entries(implementations)) {
  describe(`JiraClient contract: ${name}`, () => {
    test('implements every interface method', () => {
      const { client } = make()
      for (const m of METHODS) assert.equal(typeof client[m], 'function', m)
    })

    test('searchIssues returns normalised issues', async () => {
      const { client } = make()
      const issues = await client.searchIssues('project = PROJ')
      assert.deepEqual(
        issues.map((i) => i.key),
        ['PROJ-1', 'PROJ-2'],
      )
      const [one] = issues
      assert.equal(one.status, 'To Do')
      assert.deepEqual(one.labels, ['auth'])
      assert.equal(one.priority, 'High')
      assert.equal(one.assignee.email, 'jane@example.com')
      assert.equal(one.browseUrl, 'https://acme.atlassian.net/browse/PROJ-1')
      assert.equal(typeof one.updated, 'string')
    })

    test('getIssue returns null for an unknown key', async () => {
      assert.equal(await make().client.getIssue('PROJ-99'), null)
    })

    test('transition moves the issue to the transition target', async () => {
      const { client } = make()
      const t = (await client.getTransitions('PROJ-1')).find((x) => x.to === 'Done')
      await client.transition('PROJ-1', t.id)
      assert.equal((await client.getIssue('PROJ-1')).status, 'Done')
    })

    test('comments and remote links are recorded; remote links are keyed by globalId', async () => {
      const { client, fake } = make()
      await client.addComment('PROJ-1', 'TASK-1: done')
      const link = { url: 'https://github.com/acme/app/pull/42', title: 't', globalId: 'g1' }
      await client.addRemoteLink('PROJ-1', link)
      await client.addRemoteLink('PROJ-1', link)
      assert.deepEqual(fake.comments, [{ key: 'PROJ-1', text: 'TASK-1: done' }])
      assert.equal(fake.links('PROJ-1').length, 1)
    })

    test('a failing call rejects', async () => {
      const { client, fake } = make()
      fake.fail.addComment = ['PROJ-1']
      await assert.rejects(client.addComment('PROJ-1', 'x'))
    })
  })
}
