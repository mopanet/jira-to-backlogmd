// Atlassian Document Format -> Markdown (spec: jira-import, design D9).
// Imported text is untrusted: raw HTML and script content never reach the output.

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'rule',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'panel',
  'expand',
  'nestedExpand',
  'mediaSingle',
  'mediaGroup',
  'decisionList',
  'taskList',
])

/** Remove script/style blocks, HTML comments and tags; keep the surrounding text. */
export function stripHtml(text) {
  return String(text)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<\/?[a-zA-Z!][^>]*>/g, '')
}

const SAFE_HREF = /^(https?:|mailto:)/i

function inline(nodes = []) {
  return nodes.map(inlineNode).join('')
}

function inlineNode(n) {
  switch (n?.type) {
    case 'text':
      return applyMarks(stripHtml(n.text ?? ''), n.marks ?? [])
    case 'hardBreak':
      return '  \n'
    case 'mention':
      return stripHtml(n.attrs?.text ?? '')
    case 'emoji':
      return n.attrs?.text ?? n.attrs?.shortName ?? ''
    case 'inlineCard':
      return SAFE_HREF.test(n.attrs?.url ?? '') ? `<${n.attrs.url}>` : ''
    case 'date':
      return n.attrs?.timestamp
        ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10)
        : ''
    case 'status':
      return stripHtml(n.attrs?.text ?? '')
    default:
      return textOf(n)
  }
}

function applyMarks(text, marks) {
  if (!text) return text
  let out = text
  let href
  for (const m of marks) {
    if (m.type === 'code') out = out.includes('`') ? `\`\` ${out} \`\`` : `\`${out}\``
    else if (m.type === 'strong') out = `**${out}**`
    else if (m.type === 'em') out = `*${out}*`
    else if (m.type === 'strike') out = `~~${out}~~`
    else if (m.type === 'link') href = m.attrs?.href
  }
  return href && SAFE_HREF.test(href) ? `[${out}](${href})` : out
}

/** Plain text of any node (fallback for unknown nodes). */
function textOf(n) {
  if (!n) return ''
  if (n.type === 'text') return stripHtml(n.text ?? '')
  return (n.content ?? []).map(textOf).join('')
}

function list(node, depth, ordered) {
  let i = ordered ? (node.attrs?.order ?? 1) : 0
  return (node.content ?? [])
    .map((item) => {
      const marker = ordered ? `${i++}. ` : '- '
      const pad = '  '.repeat(depth)
      const parts = (item.content ?? []).map((c) =>
        c.type === 'bulletList' || c.type === 'orderedList'
          ? list(c, depth + 1, c.type === 'orderedList')
          : block(c, depth + 1),
      )
      const [first = '', ...rest] = parts
      return [`${pad}${marker}${first}`, ...rest].join('\n')
    })
    .join('\n')
}

function block(n, depth = 0) {
  switch (n?.type) {
    case 'paragraph':
      return inline(n.content)
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6)
      return `${'#'.repeat(level)} ${inline(n.content)}`
    }
    case 'bulletList':
      return list(n, depth, false)
    case 'orderedList':
      return list(n, depth, true)
    case 'codeBlock': {
      const code = stripHtml((n.content ?? []).map((c) => c.text ?? '').join(''))
      const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((s) => s.length))
      const fence = '`'.repeat(longest + 1)
      const lang = /^[\w+#.-]+$/.test(n.attrs?.language ?? '') ? n.attrs.language : ''
      return `${fence}${lang}\n${code}\n${fence}`
    }
    case 'blockquote':
      return blocks(n.content, depth)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n')
    case 'rule':
      return '---'
    case 'table':
      return (n.content ?? [])
        .map((row) => (row.content ?? []).map((cell) => textOf(cell).trim()).join(' | '))
        .join('\n')
    default: {
      const children = n?.content ?? []
      if (children.some((c) => BLOCK_TYPES.has(c.type))) return blocks(children, depth)
      return inline(children)
    }
  }
}

function blocks(nodes = [], depth = 0) {
  return nodes
    .map((n) => block(n, depth))
    .filter((s) => s.trim() !== '')
    .join('\n\n')
}

/** Convert an ADF document (or a plain string) to Markdown. */
export function adfToMarkdown(doc) {
  if (doc == null) return ''
  if (typeof doc === 'string') return stripHtml(doc).trim()
  return blocks(doc.content ?? []).trim()
}
