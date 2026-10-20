import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { adfToMarkdown } from '../src/jira/adf.js'

const doc = (...content) => ({ type: 'doc', version: 1, content })
const p = (...content) => ({ type: 'paragraph', content })
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) })
const li = (...content) => ({ type: 'listItem', content })

describe('adf: common nodes', () => {
  test('heading, bullet list and fenced code block', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
        { type: 'bulletList', content: [li(p(t('one'))), li(p(t('two')))] },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [t('const a = 1\nfoo()')] },
      ),
    )
    assert.equal(md, '## Steps\n\n- one\n- two\n\n```js\nconst a = 1\nfoo()\n```')
  })

  test('paragraphs and ordered list with start number', () => {
    const md = adfToMarkdown(
      doc(p(t('First paragraph.')), p(t('Second.')), {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [li(p(t('c'))), li(p(t('d')))],
      }),
    )
    assert.equal(md, 'First paragraph.\n\nSecond.\n\n3. c\n4. d')
  })

  test('nested lists are indented', () => {
    const md = adfToMarkdown(
      doc({
        type: 'bulletList',
        content: [li(p(t('a')), { type: 'bulletList', content: [li(p(t('a1')))] })],
      }),
    )
    assert.equal(md, '- a\n  - a1')
  })

  test('inline marks: bold, italic, code, strike and links', () => {
    const md = adfToMarkdown(
      doc(
        p(
          t('bold', [{ type: 'strong' }]),
          t(' '),
          t('it', [{ type: 'em' }]),
          t(' '),
          t('x()', [{ type: 'code' }]),
          t(' '),
          t('gone', [{ type: 'strike' }]),
          t(' '),
          t('site', [{ type: 'link', attrs: { href: 'https://example.com/a' } }]),
        ),
      ),
    )
    assert.equal(md, '**bold** *it* `x()` ~~gone~~ [site](https://example.com/a)')
  })

  test('hard break, rule, blockquote, mention, emoji, inline card', () => {
    const md = adfToMarkdown(
      doc(
        p(t('a'), { type: 'hardBreak' }, t('b')),
        { type: 'rule' },
        { type: 'blockquote', content: [p(t('quoted'))] },
        p(
          { type: 'mention', attrs: { id: 'x', text: '@Jane Doe' } },
          t(' '),
          { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
          t(' '),
          { type: 'inlineCard', attrs: { url: 'https://example.com/card' } },
        ),
      ),
    )
    assert.equal(md, 'a  \nb\n\n---\n\n> quoted\n\n@Jane Doe 😄 <https://example.com/card>')
  })

  test('javascript: links keep only their text', () => {
    const md = adfToMarkdown(
      doc(p(t('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
    )
    assert.equal(md, 'click')
  })

  test('empty or missing description is the empty string', () => {
    assert.equal(adfToMarkdown(null), '')
    assert.equal(adfToMarkdown(doc()), '')
  })
})

describe('adf: unsupported nodes', () => {
  test('an unknown node degrades to its text content', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('inside panel'))] },
        { type: 'mysteryNode', content: [t('mystery text')] },
        p(t('after')),
      ),
    )
    assert.equal(md, 'inside panel\n\nmystery text\n\nafter')
  })

  test('a table degrades to rows of cell text', () => {
    const cell = (s) => ({ type: 'tableCell', content: [p(t(s))] })
    const md = adfToMarkdown(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('a'), cell('b')] },
          { type: 'tableRow', content: [cell('c'), cell('d')] },
        ],
      }),
    )
    assert.equal(md, 'a | b\nc | d')
  })
})

describe('adf: HTML is dropped', () => {
  test('script tags and their content are removed', () => {
    const md = adfToMarkdown(doc(p(t('before <script>alert("x")</script> after'))))
    assert.equal(md, 'before  after')
    assert.ok(!/<script/i.test(md))
  })

  test('other tags and HTML comments are removed, text kept', () => {
    const md = adfToMarkdown(
      doc(p(t('<b>bold</b> <img src=x onerror=alert(1)> <!-- SECTION:PLAN:END --> end'))),
    )
    assert.ok(!/[<>]/.test(md.replace(/^> /gm, '')), md)
    assert.match(md, /bold/)
    assert.match(md, /end$/)
  })

  test('HTML inside code blocks is dropped too', () => {
    const md = adfToMarkdown(doc({ type: 'codeBlock', content: [t('<script>x</script>y')] }))
    assert.equal(md, '```\ny\n```')
  })

  test('a plain-string description is sanitised', () => {
    assert.equal(adfToMarkdown('hello <i>there</i>'), 'hello there')
  })
})
