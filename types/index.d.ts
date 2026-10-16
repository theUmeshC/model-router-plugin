/** The model a turn runs on: one of three tiers. */
export type Tier = 'haiku' | 'sonnet' | 'opus'

/** `auto` lets the router decide, a tier pins it, `off` leaves the session's own model alone. */
export type Mode = 'auto' | 'off' | Tier

/** Why a turn was routed to its tier. */
export type Reason = 'tag' | 'pinned' | 'heuristic' | 'llm' | 'kept' | 'cap' | 'escalated'

/** One routing decision. Holds a tier and a reason code, never any prompt text. */
export type Decision = { at: number; tier: Tier; reason: Reason; model?: string }

/** What the pane shows about the session's usage. */
export type Usage = {
  contextPercent?: number
  costUsd?: number
  limits: { kind: string; percentUsed: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      mode: Mode
      decisions: Decision[]
      usage: Usage
      answeredBy: string
    }
  }
}
