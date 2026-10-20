// Backlog.md -> Jira write-back (spec: jira-writeback, design D6-D8).
import { createHash } from 'node:crypto'
import { isMappedTo, reverseStatus } from '../config.js'

class ItemError extends Error {}

const globalIdFor = (taskId, url) =>
  `jira-to-backlogmd:${taskId}:${createHash('sha1').update(url).digest('hex')}`

const linkTitle = (taskId, url) => {
  const u = new URL(url)
  return `${taskId}: ${u.host}${u.pathname.replace(/\/$/, '')}`
}

const isHttpUrl = (s) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol)
  } catch {
    return false
  }
}

async function transitionTo(ctx, issue, target) {
  const { jira, logger, dryRun } = ctx
  const transitions = await jira.getTransitions(issue.key)
  const t = transitions.find((x) => x.to.toLowerCase() === target.toLowerCase())
  if (!t) {
    throw new ItemError(
      `${issue.key}: no direct transition from "${issue.status}" to "${target}" (available: ${transitions.map((x) => `"${x.to}"`).join(', ') || 'none'})`,
    )
  }
  if (dryRun) logger.out(`would transition ${issue.key} from "${issue.status}" to "${target}"`)
  else {
    await jira.transition(issue.key, t.id)
    logger.info(`${issue.key}: transitioned to "${target}"`)
  }
}

async function comment(ctx, key, text) {
  if (ctx.dryRun) ctx.logger.out(`would comment on ${key}: ${text.split('\n')[0]}`)
  else await ctx.jira.addComment(key, text)
}

/** Status part; returns the updated record fields (`persist` records progress mid-way). */
async function syncStatus(ctx, record, task, issue, persist) {
  const { config, backlog, logger, dryRun } = ctx
  const next = {}
  if (task.status === record.lastBacklogStatus) return next
  const targets = config.statusMapping[task.status]
  if (!targets) {
    throw new ItemError(`${task.id}: Backlog.md status "${task.status}" is not in statusMapping`)
  }
  if (isMappedTo(config, task.status, issue.status)) {
    return { lastBacklogStatus: task.status, lastJiraStatus: issue.status }
  }

  const jiraChanged = issue.status !== record.lastJiraStatus
  if (!jiraChanged) {
    await transitionTo(ctx, issue, targets[0])
    return { lastBacklogStatus: task.status, lastJiraStatus: targets[0] }
  }

  const summary = `Backlog.md ${task.id}: "${record.lastBacklogStatus}" -> "${task.status}"; Jira ${issue.key}: "${record.lastJiraStatus}" -> "${issue.status}"`
  switch (config.sync.conflictStrategy) {
    case 'backlog-wins':
      await transitionTo(ctx, issue, targets[0])
      // Record the transition before the comment, so a failing comment never repeats it.
      persist({ lastBacklogStatus: task.status, lastJiraStatus: targets[0] })
      await comment(
        ctx,
        issue.key,
        `jira-to-backlogmd: status conflict on ${task.id}.\nBacklog.md changed "${record.lastBacklogStatus}" -> "${task.status}" while Jira changed "${record.lastJiraStatus}" -> "${issue.status}".\nBacklog.md took precedence (conflictStrategy: backlog-wins), so the issue was moved to "${targets[0]}".`,
      )
      logger.warn(`conflict resolved (backlog-wins): ${summary}`)
      return { lastBacklogStatus: task.status, lastJiraStatus: targets[0] }
    case 'jira-wins': {
      const wanted = reverseStatus(config, issue.status)
      if (!wanted) {
        throw new ItemError(
          `${issue.key}: conflict (jira-wins) but Jira status "${issue.status}" is not in statusMapping`,
        )
      }
      if (dryRun) logger.out(`would set ${task.id} status to "${wanted}" (jira-wins)`)
      else await backlog.editTask(task.id, { status: wanted })
      logger.warn(`conflict resolved (jira-wins): ${summary}`)
      return { lastBacklogStatus: wanted, lastJiraStatus: issue.status }
    }
    default:
      throw new ItemError(
        `conflict skipped: ${task.id} is "${task.status}" in Backlog.md, ${issue.key} is "${issue.status}" in Jira (${summary})`,
      )
  }
}

async function syncLinks(ctx, record, task, issue, onLinked) {
  const linked = new Set(record.linkedUrls)
  const own = issue.browseUrl.toLowerCase()
  for (const url of task.references ?? []) {
    if (!isHttpUrl(url) || url.toLowerCase() === own || linked.has(url)) continue
    const link = { url, title: linkTitle(task.id, url), globalId: globalIdFor(task.id, url) }
    if (ctx.dryRun) ctx.logger.out(`would add remote link to ${issue.key}: ${url}`)
    else await ctx.jira.addRemoteLink(issue.key, link)
    linked.add(url)
    onLinked([...linked])
  }
}

async function syncSummary(ctx, record, task, issue, status) {
  if (status !== ctx.config.sync.doneStatus) return false
  if (record.summaryPosted) return true
  if (!task.finalSummary?.trim()) return false
  await comment(
    ctx,
    issue.key,
    `${task.id} completed in Backlog.md:\n\n${task.finalSummary.trim()}`,
  )
  return true
}

/** Write back every linked task, or only `taskId`. */
export async function push(ctx) {
  const { state, backlog, jira, logger, dryRun = false, taskId } = ctx
  const failures = []
  const records = taskId ? [state.byTask(taskId)].filter(Boolean) : state.all()

  for (const record of records) {
    const label = `${record.taskId} ${record.issueKey}`
    try {
      const task = await backlog.viewTask(record.taskId)
      if (!task) {
        logger.warn(
          `dangling link: ${record.taskId} (linked to ${record.issueKey}) no longer exists; skipped`,
        )
        continue
      }
      const issue = await jira.getIssue(record.issueKey)
      if (!issue) {
        logger.warn(
          `${record.issueKey} (linked to ${record.taskId}) no longer exists in Jira; skipped`,
        )
        continue
      }
      // Persist after every Jira write, so a later failure never makes a re-run repeat it.
      let current = { ...record }
      const persist = (patch) => {
        const next = { ...current, ...patch }
        if (JSON.stringify(next) === JSON.stringify(current)) return
        current = next
        if (dryRun) logger.out(`would update the store for ${label}`)
        else {
          state.set(current)
          state.save()
        }
      }
      let statusError
      try {
        persist(await syncStatus({ ...ctx, dryRun }, record, task, issue, persist))
      } catch (e) {
        if (!(e instanceof ItemError)) throw e
        statusError = e
      }
      await syncLinks({ ...ctx, dryRun }, record, task, issue, (linkedUrls) =>
        persist({ linkedUrls }),
      )
      persist({
        summaryPosted: await syncSummary(
          { ...ctx, dryRun },
          record,
          task,
          issue,
          current.lastBacklogStatus,
        ),
      })
      if (statusError) throw statusError
    } catch (e) {
      failures.push({ key: label, message: e.message })
      logger.error(`${label}: write-back failed: ${e.message}`)
    }
  }
  return { failures }
}
