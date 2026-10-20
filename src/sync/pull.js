// Jira -> Backlog.md import (spec: jira-import).
import { reverseStatus } from '../config.js'
import { adfToMarkdown } from '../jira/adf.js'

// Linux caps a single argv element at 128 KiB (bytes, not characters); stay well below it.
const MAX_DESCRIPTION_BYTES = 100_000
const PRIORITIES = { highest: 'high', high: 'high', medium: 'medium', low: 'low', lowest: 'low' }

function assigneeFor(issue, config) {
  const a = issue.assignee
  if (!a) return []
  const mapped =
    (a.accountId && config.assignees[a.accountId.toLowerCase()]) ||
    (a.email && config.assignees[a.email.toLowerCase()])
  // Backlog.md splits assignee lists on commas.
  const name = mapped || a.displayName.replace(/,/g, '').replace(/\s+/g, ' ').trim()
  return name ? [name] : []
}

function descriptionFor(issue) {
  const md = adfToMarkdown(issue.description)
  if (Buffer.byteLength(md) <= MAX_DESCRIPTION_BYTES) return md
  let bytes = 0
  let cut = ''
  for (const ch of md) {
    bytes += Buffer.byteLength(ch)
    if (bytes > MAX_DESCRIPTION_BYTES) break
    cut += ch
  }
  return `${cut}\n\n[Truncated: the full description is in ${issue.browseUrl}]`
}

/** The Jira-owned task fields for an issue; `status` is undefined when unmapped. */
export function desiredFields(issue, config) {
  return {
    title: issue.summary.trim() || issue.key,
    description: descriptionFor(issue),
    assignees: assigneeFor(issue, config),
    labels: [...issue.labels],
    priority: PRIORITIES[String(issue.priority).toLowerCase()],
    status: reverseStatus(config, issue.status),
  }
}

const sameList = (a = [], b = []) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** Content changes needed to make `task` match `want` (status handled separately). */
function contentChanges(task, want, browseUrl) {
  const changes = {}
  if (task.title !== want.title) changes.title = want.title
  if ((task.description ?? '').trim() !== want.description.trim())
    changes.description = want.description
  if (!sameList(task.assignees, want.assignees)) changes.assignees = want.assignees
  if (!sameList(task.labels, want.labels)) changes.labels = want.labels
  if (want.priority && task.priority !== want.priority) changes.priority = want.priority
  if (!(task.references ?? []).includes(browseUrl)) changes.addReferences = [browseUrl]
  return changes
}

const describeChanges = (c) =>
  Object.keys(c)
    .map((k) => (k === 'addReferences' ? 'reference' : k))
    .join(', ')

export async function pull({ config, jira, backlog, state, logger, dryRun = false }) {
  const failures = []
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 }
  const prefix = `${config.jira.projectKey}-`
  const issues = (await jira.searchIssues(config.jira.jql)).filter((issue) => {
    if (issue.key.startsWith(prefix)) return true
    logger.warn(`${issue.key}: not in project ${config.jira.projectKey}; ignored (check jira.jql)`)
    return false
  })
  const inScope = new Set(issues.map((i) => i.key))

  for (const issue of issues) {
    try {
      const want = desiredFields(issue, config)
      if (!want.status) {
        logger.warn(`${issue.key}: Jira status "${issue.status}" is not in statusMapping; skipped`)
        counts.skipped++
        continue
      }
      const link = state.get(issue.key)

      if (!link) {
        if (dryRun) {
          logger.out(`would create task for ${issue.key}: "${want.title}" (${want.status})`)
          logger.out(`would record link ${issue.key} in the store`)
          counts.created++
          continue
        }
        const taskId = await backlog.createTask({ ...want, references: [issue.browseUrl] })
        state.set({
          taskId,
          issueKey: issue.key,
          lastBacklogStatus: want.status,
          lastJiraStatus: issue.status,
          jiraUpdated: issue.updated,
        })
        state.save()
        logger.info(`${issue.key}: created ${taskId}`)
        counts.created++
        continue
      }

      // Shortcut only when nothing is pending: a status change deferred to the write-back
      // (conflict skipped or failed) is re-evaluated even if Jira did not change again.
      if (
        issue.updated &&
        issue.updated === link.jiraUpdated &&
        issue.status === link.lastJiraStatus
      ) {
        counts.unchanged++
        continue
      }
      const task = await backlog.viewTask(link.taskId)
      if (!task) {
        logger.warn(
          `dangling link: ${link.taskId} (linked to ${issue.key}) no longer exists; skipped`,
        )
        counts.skipped++
        continue
      }

      const changes = contentChanges(task, want, issue.browseUrl)
      const next = { ...link, jiraUpdated: issue.updated }
      const jiraChanged = issue.status !== link.lastJiraStatus
      const backlogChanged = task.status !== link.lastBacklogStatus
      // A local status change wins here: the write-back (push) resolves it, so the
      // last-synced Jira status must stay as is for conflict detection.
      if (jiraChanged && !backlogChanged) {
        if (task.status !== want.status) changes.status = want.status
        next.lastBacklogStatus = want.status
        next.lastJiraStatus = issue.status
      }

      if (Object.keys(changes).length === 0) {
        if (!dryRun) {
          state.set(next)
          state.save()
        }
        counts.unchanged++
        continue
      }
      if (dryRun) {
        logger.out(`would update ${task.id} from ${issue.key}: ${describeChanges(changes)}`)
        counts.updated++
        continue
      }
      await backlog.editTask(task.id, changes)
      state.set(next)
      state.save()
      logger.info(`${issue.key}: updated ${task.id} (${describeChanges(changes)})`)
      counts.updated++
    } catch (e) {
      failures.push({ key: issue.key, message: e.message })
      logger.error(`${issue.key}: import failed: ${e.message}`)
    }
  }

  for (const link of state.all()) {
    if (!inScope.has(link.issueKey)) {
      logger.info(
        `${link.issueKey}: no longer matches the selection (or was deleted); ${link.taskId} left untouched`,
      )
    }
  }
  return { failures, ...counts }
}
