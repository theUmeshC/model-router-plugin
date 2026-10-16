# model-router

A Claude Code plugin that picks the model and effort for each turn and for each subagent task, so simple work runs on a cheaper model and Opus is kept for work that needs it.

## Install

```
/plugin marketplace add theUmeshC/model-router-plugin
/plugin install model-router@model-router-plugin
```

## How a turn is routed (first match wins)

1. **Inline tag:** end a prompt with `::opus`, `::sonnet`, `::haiku` or `::auto`. The tag is removed before Claude sees the prompt.
2. **Pinned mode:** `/route opus|sonnet|haiku` sends every turn to that tier.
3. **Heuristics:** short acknowledgements keep the current tier; short questions go to Haiku; hard-work wording or very long prompts go to Opus.
4. **Unclear prompts:** a short Haiku call labels the prompt easy, standard or hard.

| Tier   | Effort | Used for                                              |
| ------ | ------ | ----------------------------------------------------- |
| Haiku  | low    | lookups, explanations, renames, formatting, exploring |
| Sonnet | medium | everyday implementation and tests                     |
| Opus   | high   | design, refactors, migrations, debugging, security    |

## Subagents

Each subagent task gets its own model: a `::tag` at the end of its prompt wins, then the agent type (`Explore`: Haiku, `Plan`: Opus), then the wording of the task. A model the caller set, forks and teammates are left alone.

## Guardrails

- Moves up at once; moves down only after 2 easy prompts in a row.
- After 3 failed tool calls in a turn, the rest of that turn moves up one tier.
- Caps at Sonnet at 85% of a plan limit and at Haiku at 95%.
- Pauses itself when you pick a model with `/model`; `/route auto` resumes it.
- Fails open: if it cannot decide, the session's own model runs the turn.
- Stores only the tier, a reason code and a timestamp, never prompt text.

## Controls

- `/route` opens the pane. `/route auto|opus|sonnet|haiku|off` sets the mode. `/route why` explains the last decision.

## Known limits

- Sends full model IDs (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`). If an account cannot use one, the API reports a model error; `/route off` turns the router off.
- Routing rules and thresholds are constants at the top of `hooks/register.tsx`.
- Tests stub the model call; they do not run against a live account.
