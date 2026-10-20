import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createLogger } from '../src/log.js'

const sink = () => {
  const lines = []
  return { lines, write: (s) => lines.push(s) }
}

describe('log: redaction', () => {
  test('the token value is shown as ***', () => {
    const err = sink()
    const log = createLogger({ secrets: ['tok-123-secret'], stderr: err })
    log.error('request failed with tok-123-secret in the body')
    assert.equal(err.lines.join(''), 'error: request failed with *** in the body\n')
  })

  test('the basic-auth credential derived from the token is redacted too', () => {
    const err = sink()
    const encoded = Buffer.from('bot@example.com:tok-123-secret').toString('base64')
    const log = createLogger({ secrets: ['tok-123-secret', encoded], stderr: err })
    log.warn(`echo ${encoded}`)
    assert.ok(!err.lines.join('').includes(encoded))
  })

  test('verbose request logging shows the Authorization header as ***', () => {
    const err = sink()
    const log = createLogger({ verbose: true, secrets: [], stderr: err })
    log.request('GET', 'https://acme.atlassian.net/rest/api/3/myself', {
      Authorization: 'Basic Ym90OnRvaw==',
      Accept: 'application/json',
    })
    const out = err.lines.join('')
    assert.match(out, /GET https:\/\/acme\.atlassian\.net\/rest\/api\/3\/myself/)
    assert.match(out, /Authorization: \*\*\*/)
    assert.ok(!out.includes('Ym90OnRvaw=='))
  })

  test('Authorization values inside free text are redacted', () => {
    const err = sink()
    const log = createLogger({ secrets: [], stderr: err })
    log.info('header was Authorization: Bearer abc.def')
    assert.equal(err.lines.join(''), 'header was Authorization: ***\n')
  })
})

describe('log: levels', () => {
  test('debug and request lines appear only with verbose', () => {
    const quiet = sink()
    createLogger({ stderr: quiet }).debug('hidden')
    createLogger({ stderr: quiet }).request('GET', 'https://x.example', {})
    assert.deepEqual(quiet.lines, [])
    const loud = sink()
    createLogger({ verbose: true, stderr: loud }).debug('shown')
    assert.equal(loud.lines.join(''), 'debug: shown\n')
  })

  test('addSecret redacts values learned later', () => {
    const err = sink()
    const log = createLogger({ stderr: err })
    log.addSecret('late-secret')
    log.info('x late-secret y')
    assert.equal(err.lines.join(''), 'x *** y\n')
  })
})
