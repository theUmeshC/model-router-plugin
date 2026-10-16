import { expect, mock, test } from 'claude-code/testing'

import {
  applyCap,
  bar,
  bump,
  capFromUsage,
  guess,
  parseMode,
  parseTag,
  routeSubagent,
  stabilize,
  statusText,
  tierFromLabel,
} from '../hooks/register'

// Synthetic prompts: no real names, numbers or code from anyone's work.
const HARD_PROMPT =
  'Please refactor the billing module so the circular dependency between invoices and payments is removed without changing the public API'
const UNSURE_PROMPT = 'fix the login button color'

test('parseTag strips a trailing tag and leaves a bare tag alone', () => {
  expect(parseTag('summarize this file ::haiku')).toEqual({ text: 'summarize this file', tag: 'haiku' })
  expect(parseTag('plan it  ::OPUS  ')).toEqual({ text: 'plan it', tag: 'opus' })
  expect(parseTag('::opus')).toEqual({ text: '::opus' })
  expect(parseTag('no tag here')).toEqual({ text: 'no tag here' })
})

test('guess tells acknowledgements, easy, hard and unsure prompts apart', () => {
  expect(guess('thanks')).toBe('keep')
  expect(guess('go ahead!')).toBe('keep')
  expect(guess('what does this function return')).toBe('easy')
  expect(guess(HARD_PROMPT)).toBe('hard')
  expect(guess(UNSURE_PROMPT)).toBe('unsure')
  expect(guess('word '.repeat(300))).toBe('hard')
})

test('capFromUsage caps by plan usage and by the optional budget', () => {
  expect(capFromUsage([], undefined)).toBe('opus')
  expect(capFromUsage([{ percentUsed: 84 }], undefined)).toBe('opus')
  expect(capFromUsage([{ percentUsed: 85 }], undefined)).toBe('sonnet')
  expect(capFromUsage([{ percentUsed: 96 }, { percentUsed: 10 }], undefined)).toBe('haiku')
  expect(capFromUsage([], 5, 4)).toBe('sonnet')
  expect(capFromUsage([], 6, 4)).toBe('haiku')
  expect(capFromUsage([], 99, 0)).toBe('opus')
})

test('stabilize moves up at once and steps down after two easy prompts', () => {
  expect(stabilize(undefined, 'haiku', 0)).toEqual({ tier: 'haiku', easyStreak: 0 })
  expect(stabilize('sonnet', 'opus', 1)).toEqual({ tier: 'opus', easyStreak: 0 })
  const first = stabilize('opus', 'haiku', 0)
  expect(first).toEqual({ tier: 'opus', easyStreak: 1 })
  expect(stabilize('opus', 'haiku', first.easyStreak)).toEqual({ tier: 'haiku', easyStreak: 0 })
})

test('small helpers behave', () => {
  expect(bump('haiku')).toBe('sonnet')
  expect(bump('opus')).toBe('opus')
  expect(applyCap('opus', 'sonnet')).toBe('sonnet')
  expect(applyCap('haiku', 'sonnet')).toBe('haiku')
  expect(parseMode(' Opus ')).toBe('opus')
  expect(parseMode('fast')).toBeUndefined()
  expect(tierFromLabel('Standard.')).toBe('sonnet')
  expect(tierFromLabel('I am not sure')).toBeUndefined()
  expect(bar(40, 10)).toBe('████░░░░░░')
  expect(bar(250, 4)).toBe('████')
})

test('statusText names the tier, the mode and the five-hour window', () => {
  expect(statusText('auto', 'sonnet', [])).toBe('router: sonnet·medium (auto)')
  expect(statusText('opus', 'opus', [{ kind: 'five_hour', percentUsed: 41.6 }])).toBe(
    'router: opus·high (pinned) · 5h 42%',
  )
  expect(statusText('off', undefined, [])).toBe('router: off')
  expect(statusText('auto', undefined, [])).toBe('router: auto')
})

type Seen = { model?: string; effort?: unknown; text?: string; status: string[]; toasts: string[]; saved: Map<string, unknown> }

/** Answers every call the mod makes in Claude Code's place; returns what the stubs saw. */
function stub(
  on: Parameters<Parameters<typeof test>[1]>[1],
  options: { label?: string; limits?: { kind: string; percentUsed: number }[]; failToolCalls?: boolean } = {},
): Seen {
  const seen: Seen = { status: [], toasts: [], saved: new Map() }
  mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('command.register', () => ({ value: undefined }))
  on('store.get', ($, e) => ({ value: seen.saved.get(e.key) }))
  on('store.set', ($, e) => {
    seen.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: options.limits ?? [], cost: { usd: 1 } },
  }))
  on('model.complete', () =>
    options.label === undefined
      ? { deny: 'no model in tests' }
      : {
          value: {
            isAnswered: true,
            text: options.label,
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
  )
  on('prompt.submit', ($, e) => {
    seen.text = e.text
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok', ...(options.failToolCalls ? { isError: true } : {}) }))
  on('turn.step', async function* ($, e) {
    seen.model = e.model
    seen.effort = e.effort
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))

  return seen
}

type Kit = Parameters<Parameters<typeof test>[1]>[0]

async function submit($: Kit, text: string, turnId = 't1'): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
}

async function step($: Kit, turnId = 't1', agentId?: string): Promise<void> {
  const stream = $.turn.step({
    turnId,
    index: 0,
    model: 'claude-test',
    messageCount: 1,
    ...(agentId === undefined ? {} : { agentId }),
  })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
}

const start = ($: Kit) => $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' })

test('a hard prompt runs the turn on opus with high effort and says so in the status line', async ($, on) => {
  const seen = stub(on)
  await start($)
  await submit($, HARD_PROMPT)
  await step($)

  expect(seen.model).toBe('claude-opus-5-5')
  expect(seen.effort).toBe('high')
  expect(seen.status[seen.status.length - 1]).toBe('router: opus·high (auto)')
})

test('an unsure prompt takes the tier Haiku labels it with', async ($, on) => {
  const seen = stub(on, { label: 'standard' })
  await start($)
  await submit($, UNSURE_PROMPT)
  await step($)

  expect(seen.model).toBe('claude-sonnet-5-5')
  expect(seen.effort).toBe('medium')
})

test('when the label call fails the session keeps its own model', async ($, on) => {
  const seen = stub(on)
  await start($)
  await submit($, UNSURE_PROMPT)
  await step($)

  expect(seen.model).toBe('claude-test')
})

test('a ::tag picks the tier for one turn and is stripped from the prompt', async ($, on) => {
  const seen = stub(on)
  await start($)
  await submit($, 'summarize this file ::haiku')
  await step($)

  expect(seen.text).toBe('summarize this file')
  expect(seen.model).toBe('claude-haiku-5-5')
  expect(seen.effort).toBe('low')
})

test('a subagent request is left alone', async ($, on) => {
  const seen = stub(on)
  await start($)
  await submit($, HARD_PROMPT)
  await step($, 't1', 'agent-1')

  expect(seen.model).toBe('claude-test')
})

test('/route off hands the model back to the session', async ($, on) => {
  const seen = stub(on)
  await start($)
  const answer = await $.command.run({ command: 'route', args: 'off' })
  await submit($, HARD_PROMPT)
  await step($)

  expect(answer.text).toBe('Model router: off')
  expect(seen.saved.get('mode')).toBe('off')
  expect(seen.model).toBe('claude-test')
})

test('/route rejects a word that is not a mode', async ($, on) => {
  stub(on)
  await start($)
  const answer = await $.command.run({ command: 'route', args: 'turbo' })

  expect(answer.text).toBe('Usage: /route [auto|opus|sonnet|haiku|off|why]')
})

test('high plan usage caps an opus turn at sonnet', async ($, on) => {
  const seen = stub(on, { limits: [{ kind: 'five_hour', percentUsed: 90 }] })
  await start($)
  await submit($, HARD_PROMPT)
  await step($)

  expect(seen.model).toBe('claude-sonnet-5-5')
})

test('three failed tool calls move the rest of the turn up a tier', async ($, on) => {
  const seen = stub(on, { label: 'standard', failToolCalls: true })
  await start($)
  await submit($, UNSURE_PROMPT)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'false' })
  await step($)

  expect(seen.model).toBe('claude-opus-5-5')
  expect(seen.effort).toBe('high')
})

test('a mismatch between the tier asked for and the model that answered raises a toast', async ($, on) => {
  const seen = stub(on)
  await start($)
  await submit($, HARD_PROMPT)
  await step($)
  await $.turn.complete({
    turnId: 't1',
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    usage: {
      model: 'claude-sonnet-5-5',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })

  expect(seen.toasts[0]).toBe('router: asked for opus, the API answered with claude-sonnet-5-5')
})

const spawnArgs = {
  tool_use_id: 'u1',
  prompt: 'look around',
  description: 'look around',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-test',
  background: false,
  fork: false,
} as const

test('routeSubagent picks a tier per task: tag, then agent type, then wording', () => {
  expect(routeSubagent('general-purpose', 'task', 'do it ::opus')).toEqual({ tier: 'opus', prompt: 'do it' })
  expect(routeSubagent('Explore', 'look', 'find files')).toEqual({ tier: 'haiku', prompt: 'find files' })
  expect(routeSubagent('Plan', 'plan', 'outline steps').tier).toBe('opus')
  expect(routeSubagent('general-purpose', 'Refactor billing module', 'split the services').tier).toBe('opus')
  expect(routeSubagent('general-purpose', 'Rename constants', 'rename FOO to BAR').tier).toBe('haiku')
  expect(routeSubagent('general-purpose', 'Add login button', 'add a button').tier).toBe('sonnet')
  expect(routeSubagent('general-purpose', 'Add button', 'tidy up ::auto')).toEqual({ tier: 'sonnet', prompt: 'tidy up' })
})

test('each subagent with no model set is routed by its task; a set model and forks are left alone', async ($, on) => {
  stub(on)
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'inherit', agentId: 'a1' }))
  await start($)

  const explore = await $.agent.spawn(spawnArgs)
  const planner = await $.agent.spawn({ ...spawnArgs, subagentType: 'Plan' })
  const worker = await $.agent.spawn({ ...spawnArgs, subagentType: 'general-purpose', description: 'Add login button' })
  const tagged = await $.agent.spawn({ ...spawnArgs, subagentType: 'general-purpose', prompt: 'tidy ::haiku' })
  const chosen = await $.agent.spawn({ ...spawnArgs, model: 'opus' })
  const forked = await $.agent.spawn({ ...spawnArgs, fork: true })

  expect(explore.model).toBe('claude-haiku-5-5')
  expect(planner.model).toBe('claude-opus-5-5')
  expect(worker.model).toBe('claude-sonnet-5-5')
  expect(tagged.model).toBe('claude-haiku-5-5')
  expect(chosen.model).toBe('opus')
  expect(forked.model).toBe('inherit')
})

test('choosing a model with /model pauses the router; an automatic switch does not', async ($, on) => {
  const seen = stub(on)
  on('classic.PostModelSwitch', () => ({}))
  await start($)

  await $.classic.PostModelSwitch({ source: 'auto', from_model: 'a', to_model: 'b', requested_model: null })
  expect(seen.saved.get('mode')).toBeUndefined()

  await $.classic.PostModelSwitch({ source: 'picker', from_model: 'a', to_model: 'b', requested_model: 'opus' })
  expect(seen.saved.get('mode')).toBe('off')
  expect(seen.toasts[0]).toBe('Model router paused because you chose a model. /route auto resumes it.')
})

test('the pane draws on the VS Code panel and a Select pick is saved', async ($, on) => {
  const seen = stub(on)
  await start($)
  const ui = await $.ui.mount({
    plugin: 'model-router',
    component: 'Pane',
    requestId: 'model-router',
    surface: 'vscode',
    viewport: { columns: 100, rows: 30 },
    props: {
      title: 'Model router',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Select', key: 'mode' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No routed turn yet.' })).toBeDefined()
  await ui.select({ key: 'mode', value: 'sonnet' })
  expect(seen.saved.get('mode')).toBe('sonnet')
  await ui.unmount()
})
