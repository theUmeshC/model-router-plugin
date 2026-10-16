/**
 * model-router: picks the model and effort for each turn, shows the choice in a
 * status line and a pane, and answers /route.
 *
 * The routing rules are plain exported functions so tests can call them without
 * a session. Every hook fails open: if the router cannot decide, the session's
 * own model runs the turn. Nothing here logs or stores prompt text.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Mode, Reason, Tier, Usage } from '../types'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
export const MODES: readonly Mode[] = ['auto', 'opus', 'sonnet', 'haiku', 'off']
export const EFFORT: Record<Tier, 'low' | 'medium' | 'high'> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
}
/** What turn.step is asked to send for each tier: full model IDs, as the account's own settings use them. */
export const MODEL: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

/** Plan usage at or above this percent caps the tier at Sonnet, then at Haiku. */
export const CAP_SONNET_AT = 85
export const CAP_HAIKU_AT = 95
/** Session cost in USD that caps the tier at Sonnet (1.5x: Haiku). 0 turns the budget off. */
export const BUDGET_USD = 0
/** Failed tool calls in one turn before the rest of the turn moves up a tier. */
export const ESCALATE_AFTER = 3
/** Easy prompts in a row before the router steps down a tier. */
export const DOWNSHIFT_AFTER = 2

const MAX_DECISIONS = 8
const CLASSIFY_CHARS = 1500
const CLASSIFY_TIMEOUT_MS = 8000
const PANE = 'model-router'

export const REASON_TEXT: Record<Reason, string> = {
  tag: 'a ::tag on the prompt',
  pinned: 'the pinned mode',
  heuristic: 'the size and wording of the prompt',
  llm: 'a Haiku difficulty label',
  kept: 'a short follow-up, so the last tier stays',
  cap: 'plan usage is high, so the tier is capped',
  escalated: 'tool calls kept failing in this turn',
}

const MODE_OPTIONS = [
  { value: 'auto', label: 'Auto (router decides)' },
  { value: 'opus', label: 'Always Opus' },
  { value: 'sonnet', label: 'Always Sonnet' },
  { value: 'haiku', label: 'Always Haiku' },
  { value: 'off', label: 'Off (session default)' },
]

type Limit = { kind: string; percentUsed: number }

const rank = (tier: Tier): number => TIERS.indexOf(tier)

/** The next tier up, or the same one at the top. */
export const bump = (tier: Tier): Tier => TIERS[Math.min(rank(tier) + 1, TIERS.length - 1)]

/** The lower of a tier and a cap. */
export const applyCap = (tier: Tier, cap: Tier): Tier => (rank(tier) > rank(cap) ? cap : tier)

/** A mode named by the user, or undefined when the word is not one. */
export function parseMode(word: string): Mode | undefined {
  const w = word.trim().toLowerCase()
  return (MODES as readonly string[]).includes(w) ? (w as Mode) : undefined
}

/**
 * Splits a trailing `::opus`, `::sonnet`, `::haiku` or `::auto` tag off a prompt.
 * A prompt that is only a tag is left whole, so the turn never starts empty.
 */
export function parseTag(text: string): { text: string; tag?: Tier | 'auto' } {
  const m = /\s*::(opus|sonnet|haiku|auto)\s*$/i.exec(text)
  if (m === null) return { text }
  const rest = text.slice(0, m.index).trimEnd()
  if (rest === '') return { text }
  return { text: rest, tag: m[1].toLowerCase() as Tier | 'auto' }
}

export type Guess = 'keep' | 'easy' | 'hard' | 'unsure'

const ACK =
  /^(ok|okay|yes|yep|yeah|sure|thanks|thank you|go|go ahead|continue|proceed|do it|y|n|no|nope|looks good|lgtm)\b[\s.!?]*$/i
const HARD =
  /\b(refactor|architect\w*|design|migrat\w*|root cause|debug\w*|race condition|deadlock|security|vulnerab\w*|performance|optimi[sz]\w*|concurren\w*|rewrite|trade-?offs?|investigate)\b/i
const EASY = /^(what|who|when|where|which|how (do|does|to)|explain|show|list|rename|format|summari[sz]e|translate|define)\b/i

/**
 * A cheap read of how hard a prompt is. `keep` is a short acknowledgement that
 * should not change the tier; `unsure` is worth a model's second opinion.
 */
export function guess(text: string): Guess {
  const t = text.trim()
  const words = t === '' ? 0 : t.split(/\s+/).length
  if (words === 0 || ACK.test(t)) return 'keep'
  const hasCode = t.includes('```')
  const isHard = HARD.test(t)
  if (words > 250 || (hasCode && words > 60) || (isHard && words > 12)) return 'hard'
  if (EASY.test(t) && words <= 40 && !isHard && !hasCode) return 'easy'
  return 'unsure'
}

const SUBAGENT_HEAD_CHARS = 400

/**
 * The tier for one subagent task, so each task of a plan gets a model that fits it.
 * A `::tag` in the task's prompt wins (and is stripped); then the agent type
 * (Explore reads, Plan decides); then the wording of the description and the start
 * of the prompt. Costs no model call, so a spawn is never delayed.
 */
export function routeSubagent(
  subagentType: string,
  description: string,
  prompt: string,
): { tier: Tier; prompt: string } {
  const { text, tag } = parseTag(prompt)
  if (tag !== undefined && tag !== 'auto') return { tier: tag, prompt: text }
  if (subagentType === 'Explore') return { tier: 'haiku', prompt: text }
  if (subagentType === 'Plan') return { tier: 'opus', prompt: text }
  const head = `${description}. ${text.slice(0, SUBAGENT_HEAD_CHARS)}`
  const tier: Tier = HARD.test(head) ? 'opus' : EASY.test(description.trim()) ? 'haiku' : 'sonnet'

  return { tier, prompt: text }
}

/** The tier a Haiku label names, or undefined when the reply holds none of the labels. */
export function tierFromLabel(label: string): Tier | undefined {
  const m = /\b(easy|standard|hard)\b/i.exec(label)
  if (m === null) return undefined
  const word = m[1].toLowerCase()
  return word === 'easy' ? 'haiku' : word === 'standard' ? 'sonnet' : 'opus'
}

/** The highest tier plan usage and the optional budget allow. */
export function capFromUsage(
  limits: readonly Pick<Limit, 'percentUsed'>[],
  costUsd: number | undefined,
  budgetUsd: number = BUDGET_USD,
): Tier {
  const worst = limits.reduce((most, one) => Math.max(most, one.percentUsed), 0)
  if (worst >= CAP_HAIKU_AT) return 'haiku'
  if (worst >= CAP_SONNET_AT) return 'sonnet'
  if (budgetUsd > 0 && costUsd !== undefined) {
    if (costUsd >= budgetUsd * 1.5) return 'haiku'
    if (costUsd >= budgetUsd) return 'sonnet'
  }
  return 'opus'
}

/** Moves up at once, steps down only after enough easy prompts in a row. */
export function stabilize(
  prev: Tier | undefined,
  want: Tier,
  easyStreak: number,
): { tier: Tier; easyStreak: number } {
  if (prev === undefined || rank(want) >= rank(prev)) return { tier: want, easyStreak: 0 }
  const streak = easyStreak + 1
  return streak >= DOWNSHIFT_AFTER ? { tier: want, easyStreak: 0 } : { tier: prev, easyStreak: streak }
}

/** The one-line status: `router: sonnet·medium (auto) · 5h 42%`. */
export function statusText(mode: Mode, tier: Tier | undefined, limits: readonly Limit[]): string {
  const how = mode === 'auto' ? 'auto' : 'pinned'
  const base =
    mode === 'off'
      ? 'router: off'
      : tier === undefined
        ? `router: ${mode}`
        : `router: ${tier}·${EFFORT[tier]} (${how})`
  const five = limits.find(one => one.kind === 'five_hour')
  return five === undefined ? base : `${base} · 5h ${Math.round(five.percentUsed)}%`
}

/** A text gauge: `bar(40, 10)` is `████░░░░░░`. */
export function bar(percent: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5)

type Route = { tier: Tier; reason: Reason; sent?: Tier }

const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'auto')
const decisions = atom({ plugin: 'model-router', key: 'decisions' } as const, [])
const usage = atom({ plugin: 'model-router', key: 'usage' } as const, { limits: [] })
const answeredBy = atom({ plugin: 'model-router', key: 'answeredBy' } as const, '')

// Module variables start over on a reload; the atoms above and `$.store` do not.
let pending: Route | undefined
let shown: Tier | undefined
let lastTier: Tier | undefined
let easyStreak = 0
let limits: readonly Limit[] = []
let toolErrors = 0
const turns = new Map<string, Route>()

// Helpers that take `$` are declared up here: the validator follows `$` only into
// functions declared at the top of the file.
async function refreshStatus($: EngineInterface): Promise<void> {
  $.ui.status(statusText(await read($, mode), shown, limits))
}

async function setMode($: EngineInterface, next: Mode): Promise<void> {
  await update($, mode, () => next)
  await $.store.set('mode', next)
  lastTier = undefined
  easyStreak = 0
  await refreshStatus($)
}

async function loadMode($: EngineInterface): Promise<void> {
  const saved = await $.store.get('mode')
  const found = typeof saved === 'string' ? parseMode(saved) : undefined
  if (found !== undefined) await update($, mode, () => found)
}

async function record($: EngineInterface, route: Route): Promise<void> {
  const at = await $.clock.now()
  const entry: Decision = { at, tier: route.tier, reason: route.reason }
  await update($, decisions, list => [entry, ...list].slice(0, MAX_DECISIONS))
}

async function llmTier($: EngineInterface, text: string): Promise<Tier | undefined> {
  try {
    const r = await $.model.complete({
      model: MODEL.haiku,
      system:
        "Rate how hard the user's request to a coding assistant is. Reply with exactly one word: easy, standard, or hard.",
      prompt: text.slice(0, CLASSIFY_CHARS),
      maxTokens: 8,
      effort: 'low',
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    })
    return r.isAnswered ? tierFromLabel(r.text) : undefined
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadMode($)
    await refreshStatus($)
    // Last, because a name that is taken makes register throw.
    try {
      await $.command.register({
        name: 'route',
        description: 'Model router: open the pane, set a mode, or ask why',
        argumentHint: '[auto|opus|sonnet|haiku|off|why]',
      })
    } catch {
      // Another plugin or a built-in owns /route; the pane and status line still work.
    }

    return next(e)
  })

  // /clear resets the session's values, so read the saved mode again.
  on('classic.SessionStart', async ($, e, next) => {
    await loadMode($)
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === '') {
      const opened = await $.ui.open({ id: PANE, title: 'Model router' })

      return opened.isPlaced ? {} : { text: 'Model router pane is waiting; widen the window to see it.' }
    }

    if (arg === 'why') {
      const latest = (await read($, decisions))[0]

      return {
        text:
          latest === undefined
            ? 'Model router: no routed turn yet.'
            : `Model router: ${latest.tier} (${EFFORT[latest.tier]} effort) because of ${REASON_TEXT[latest.reason]}.`,
      }
    }

    const picked = parseMode(arg)
    if (picked === undefined) return { text: 'Usage: /route [auto|opus|sonnet|haiku|off|why]' }
    await setMode($, picked)

    return { text: `Model router: ${picked}` }
  })

  on('prompt.submit', async ($, e, next) => {
    pending = undefined
    const kind = e.origin.kind
    const isPerson = kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'unclassified'
    if (e.command !== undefined || e.isMeta === true || !isPerson) return next(e)

    const current = await read($, mode)
    if (current === 'off') return next(e)

    const { text, tag } = parseTag(e.text)

    let used = { rateLimits: [] as readonly Limit[], cost: undefined as { usd: number } | undefined }
    try {
      used = await $.session.usage()
    } catch {
      // No usage figures: route without a cap.
    }
    limits = used.rateLimits
    const cap = capFromUsage(used.rateLimits, used.cost?.usd)

    let route: Route | undefined
    if (tag !== undefined && tag !== 'auto') {
      route = { tier: tag, reason: 'tag' }
    } else if (current !== 'auto' && tag !== 'auto') {
      route = { tier: current, reason: 'pinned' }
    } else {
      const g = guess(text)
      if (g === 'keep') {
        if (lastTier !== undefined) route = { tier: lastTier, reason: 'kept' }
      } else {
        const reason: Reason = g === 'unsure' ? 'llm' : 'heuristic'
        const want = g === 'easy' ? 'haiku' : g === 'hard' ? 'opus' : await llmTier($, text)
        if (want !== undefined) {
          const steady = stabilize(lastTier, want, easyStreak)
          easyStreak = steady.easyStreak
          lastTier = steady.tier
          route = { tier: steady.tier, reason }
        }
      }
    }

    if (route !== undefined) {
      const capped = applyCap(route.tier, cap)
      if (capped !== route.tier) route = { tier: capped, reason: 'cap' }
    }
    pending = route

    return next(text === e.text ? e : { ...e, text })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      toolErrors = 0
      if (pending !== undefined) {
        if (turns.size >= 20) turns.clear()
        turns.set(e.turnId, pending)
        shown = pending.tier
        await record($, pending)
        pending = undefined
        await refreshStatus($)
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const route = e.agentId === undefined ? turns.get(e.turnId) : undefined
    if (route === undefined) return yield* next(e)

    const tier = toolErrors >= ESCALATE_AFTER ? bump(route.tier) : route.tier
    route.sent = tier
    if (tier !== route.tier && route.reason !== 'escalated') {
      route.reason = 'escalated'
      shown = tier
      await record($, { tier, reason: 'escalated' })
      await refreshStatus($)
    }

    return yield* next({ ...e, model: MODEL[tier], effort: EFFORT[tier] })
  })

  // Counts failed tool calls in the main loop, so a struggling turn can move up a tier.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError === true) toolErrors += 1

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const route = turns.get(e.turnId)
      turns.delete(e.turnId)
      const model = e.usage?.model
      if (model !== undefined) {
        await update($, answeredBy, () => model)
        await update($, decisions, list =>
          list.length === 0 || list[0].model !== undefined ? list : [{ ...list[0], model }, ...list.slice(1)],
        )
        if (route?.sent !== undefined && !model.toLowerCase().includes(route.sent)) {
          $.ui.toast(`router: asked for ${route.sent}, the API answered with ${model}`)
        }
      }
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    limits = e.rateLimits
    const figures: Usage = {
      contextPercent: e.context.percent,
      costUsd: e.cost?.usd,
      limits: e.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed })),
    }
    await update($, usage, () => figures)
    await refreshStatus($)

    return next(e)
  })

  // Each subagent task gets its own tier, so executing a plan through subagents uses
  // a model that fits each task: a `::tag` in the task prompt, else the agent type
  // and wording. Any model the caller set stays; the plan-usage cap still applies.
  on('agent.spawn', async ($, e, next) => {
    const current = await read($, mode)
    if (current !== 'auto' || e.fork || e.isTeammate === true || e.model !== undefined) return next(e)

    const picked = routeSubagent(e.subagentType, e.description, e.prompt)
    const tier = applyCap(picked.tier, capFromUsage(limits, undefined))

    return next({ ...e, prompt: picked.prompt, model: MODEL[tier] })
  })

  // A model the person picks themselves wins: pause the router until /route auto.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if ((e.source === 'command' || e.source === 'picker') && (await read($, mode)) !== 'off') {
      await setMode($, 'off')
      $.ui.toast('Model router paused because you chose a model. /route auto resumes it.')
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const current = await read($, mode)
    const list = await read($, decisions)
    const figures = await read($, usage)
    const by = await read($, answeredBy)
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 24))
    const latest = list[0]

    return (
      <Box flexDirection="column" gap={1}>
        <Select
          key="mode"
          label="Mode"
          value={current}
          options={MODE_OPTIONS}
          onSelect={value => {
            const picked = parseMode(value)
            if (picked !== undefined) void setMode($, picked)
          }}
        />
        <Box flexDirection="column">
          <Text bold>Now</Text>
          <Text>
            {latest === undefined
              ? 'No routed turn yet.'
              : `${latest.tier} · ${EFFORT[latest.tier]} effort · ${REASON_TEXT[latest.reason]}`}
          </Text>
          {by !== '' && <Text dimColor>{`Answered by ${by}`}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Usage</Text>
          {figures.contextPercent !== undefined && (
            <Text>{`Context ${bar(figures.contextPercent, width)} ${Math.round(figures.contextPercent)}%`}</Text>
          )}
          {figures.costUsd !== undefined && <Text>{`Cost $${figures.costUsd.toFixed(2)}`}</Text>}
          <Text dimColor>
            {figures.limits.length === 0
              ? 'No plan-limit data reported.'
              : figures.limits.map(one => `${one.kind} ${Math.round(one.percentUsed)}%`).join(' · ')}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Recent</Text>
          {list.length === 0 && <Text dimColor>Nothing yet.</Text>}
          {list.map(one => (
            <Text dimColor>{`${hhmm(one.at)}  ${one.tier}  ${one.reason}${one.model ? `  ${one.model}` : ''}`}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}
