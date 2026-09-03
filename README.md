# MHS Bench

A prototype of an autonomous experiment loop running against simulated lab instruments, modeled on the
Model Hardware Standard (MHS) pilot Genentech ran with Claude. A Claude agent finds the best liquid handler
flow rate for a protein sample by proposing experiments, a human (or a reviewer agent) approves them, and the
loop runs them on a simulated liquid handler and plate reader. You can inject faults mid-run and watch the
driver, the agent, and the loop respond.

Live: https://mhsbench-production.up.railway.app

## What you can do

1. Pick a sample: water (a simple aqueous reagent) or BSA (a viscous, foamy protein).
2. Watch Claude run the loop: review history, propose a hypothesis, run it, read the plate, evaluate, repeat.
3. Auto mode is on by default: a rule-based reviewer accepts or rejects each hypothesis. Turn it off to accept, edit, or reject each hypothesis yourself.
4. Inject a fault: a failed tip pickup, a clogged tip, or bubbles in the wells.
5. Watch the fault attempt counter. After three failed recovery attempts the run escalates and a human must approve every step until the fault is cleared. Preset guidance buttons let you tell the agent what is physically wrong.
6. If the Claude API keeps failing for about a minute, the run pauses with the error and a Retry button. There is no hidden fallback: the agent is Claude or nothing.
7. Replay any run from its event log.
8. Watch a demo: three recorded runs, one per fault, replay in the browser with no server and no model in the loop. The replay lingers on each hypothesis so the agent's reasoning can be read.

## How it works

The event log is the only source of truth. The server appends events; the browser folds them into screen state
with a pure reducer (`src/shared/reducer.ts`). Replay is folding fewer events.

| Piece | File | What it does |
|---|---|---|
| Simulator + driver | `src/server/lab/bench.ts` | The fake bench and the MHS-style driver in front of it. The driver enforces the manifest ranges; only the driver can see the simulator. Faults are injected through a separate control channel the driver never sees. |
| Run loop | `src/server/loop.ts` | Deterministic code that turns a proposal into driver commands, waits for approval, evaluates results, and keeps the fault attempt counter. |
| Agent | `src/server/agents/claude.ts` | One Claude call per turn, returning one JSON proposal. Claude chooses parameters; the loop operates the instruments. |
| Reviewer | `src/server/agents/reviewer.ts` | Three rules for auto mode. Never approves an escalation. |
| Runs and API | `src/server/runs.ts`, `src/server/index.ts` | In-memory runs, idempotent command endpoints, Server-Sent Events. Two browser tabs get two independent runs. |
| Interface | `src/client/App.tsx` | Everything on screen, in one file. |

### The simulation, in one sentence

Error grows with how far the flow rate is from the ideal, on a log scale, and BSA is about seven times less
forgiving than water: `rmse = floor + k * |ln(flow / ideal)|`. Water: ideal 140 µL/s, floor 0.016, k 0.02.
BSA: ideal 10 µL/s, floor 0.181, k 0.15. Those are the Genentech pilot's numbers. This is a simulation, not fluid physics.

### Faults

| Fault | What the agent sees | What clears it |
|---|---|---|
| Failed tip pickup | `E-101 TIP_PICKUP_FAILED` on the next pickup | Picking up at the next rack position |
| Clogged tip | Delivered volume drops to about 55% and stops responding to flow rate. No error code. | Replacing the tip |
| Bubbles | `E-217 FLUID_DETECTION_ERROR` on every transfer | Only after a human is in the loop: clean wells and at most one mixing cycle |

The bubbles rule is deliberate. In the pilot, Claude kept retrying in the same well and needed a person to explain
the physics. Here nothing clears bubbles before the third attempt escalates to a human.

## Demos

`public/demos/*.json` are real runs recorded once with `bun scripts/record-demo.ts tip|clog|bubbles` against a running
server. The script starts a run in auto mode, injects the fault after the third experiment, plays the human when the run
escalates (guidance for bubbles, approval otherwise), and saves the whole event log. The browser replays a fixture through
the same reducer as a live run, so the demo is the product, not a mock-up.

## Running it locally

```bash
bun install
cp .env.example .env   # then fill in the values
bun run dev            # builds the client, starts the server on http://localhost:3000
bun test               # simulator tests
bun run typecheck
```

Environment variables: `ANTHROPIC_API_KEY` (required), `ANTHROPIC_WORKSPACE_ID` (required for identity-linked keys),
`AGENT_MODEL` (optional, default `claude-sonnet-5`), `PORT` (optional).

## Design decisions and tradeoffs

- **One JSON proposal per turn instead of driver tool calls.** Cheaper, faster, and one card shape in the interface. The cost is that Claude never calls the driver directly, so the driver-as-safety-boundary is shown at the parameter level only. The faithful MHS form (tools generated from the driver manifest) is the first thing to add with more time.
- **No scripted fallback agent.** A demo where a heuristic quietly stands in for the model would mislead the reviewer. Failure is shown, and a human restarts.
- **Escalation cannot be dodged.** Rejected recovery proposals count toward the three attempts, and auto mode never approves an escalation.
- **Idempotent decisions.** A decision is accepted only for the hypothesis that is actually waiting. A stale click cannot approve the wrong experiment.
- **Two successes in a row end the run.** The confirmed parameters are written to `results/<run id>.json`, read back from disk, and shown in the interface, so the outcome of a run is a plain file another tool can pick up.

## With more time

Compile a successful recovery into a deterministic script and replay it with no model in the loop (the QuEra
result); seed history from other samples for the agent to read; a Haiku reviewer agent instead of rules; persist
runs in Turso; a zoomable timeline; agent evals across seeded faults.

## Time spent

Planning about 1.5 hours (with Claude Code), building about 1 hour.
