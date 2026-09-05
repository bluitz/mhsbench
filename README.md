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
3. Auto mode is on by default: a rule-based reviewer accepts or rejects each hypothesis. Turn it off, before or during a run, to accept, edit, or reject each hypothesis yourself.
4. Inject a fault: a failed tip pickup, a clogged tip, or bubbles in the wells. One fault at a time; the buttons come back once it is recovered.
5. Watch the fault attempt counter. After three failed recovery attempts the run escalates and a human must approve every step until the fault is cleared. As soon as a fault is detected, preset guidance buttons let you tell the agent what is physically wrong; guidance replaces the pending hypothesis and the agent re-plans with it.
6. If the Claude API keeps failing for about a minute, the run pauses with the error and a Retry button. There is no hidden fallback: the agent is Claude or nothing.
7. Replay any run from its event log.
8. Lower a safety limit mid-run. The driver enforces the new flow-rate limit at once while the agent's reference text still says 250, so its next high proposal is refused by the driver and never reaches the device. The agent reads the rejection and continues within the new limit.
9. Watch a demo: four recorded runs (three faults and the limit change) replay in the browser with no run on the server and no model in the loop. See [Demo modes](#demo-modes).

## Demo modes

Each demo is a real run of the Claude agent, recorded once against the simulator and saved as an event log in
`public/demos/<name>.json`. The browser fetches the file and folds it through the same reducer as a live run, so
the demo is the product, not a mock-up. Nothing calls the model, so demos work on the live site and on a local
server with no API key.

### Opening a demo

- Click one of the purple **Demo: ...** buttons in the header. The one playing stays highlighted.
- Or open the page with a hash: `#demo=tip`, `#demo=clog`, `#demo=bubbles`, or `#demo=limit`.
  For example https://mhsbench-production.up.railway.app/#demo=bubbles.

### While a demo plays

- The header shows the demo's title, a **Replaying a recorded run** badge, and a two-line description of what to watch for.
- Events appear one at a time at a reading pace: about 2.5 seconds on each hypothesis so its rationale can be read, about 1.2 seconds on each result, fault event, and guidance message, and quickly through driver commands.
- Every control is disabled. Faults, guidance, decisions, and the limit cannot be changed, because the outcome is already recorded.
- **Restart demo** at the bottom of the event log plays it again from the first event. **New run** returns to the start screen.
- When the recording ends, the saved result appears as a table. The link to the result file is hidden, since the file is not on the server.

### The four demos

Every demo starts in auto mode. The fault is injected, or the limit lowered, after the third completed experiment, so the flow-rate sweep is already under way.

| Demo | Sample | What happens | What to watch for |
|---|---|---|---|
| Failed tip pickup (`tip`) | Water | The next tip pickup fails with `E-101 TIP_PICKUP_FAILED` and no liquid moves. | The agent reads the error code and proposes retrying the pickup at the next rack position. The fault clears on the first attempt. |
| Clogged tip (`clog`) | BSA | The tip delivers about 55% of the volume from then on. There is no error code, only a low mean delivered fraction. | The agent changes the flow rate once to see whether delivery responds, sees that it does not, names the clog, and replaces the tip. Recovery takes two attempts. |
| Bubbles in the wells (`bubbles`) | BSA | Every transfer fails with `E-217 FLUID_DETECTION_ERROR`. | Three recovery attempts fail and the run escalates. The escalated proposal includes a diagnosis. The human sends the bubbles guidance, the agent moves to clean wells with at most one mixing cycle, and only then does the fault clear. |
| Driver rejects an unsafe request (`limit`) | BSA | An operator lowers the flow-rate limit to 100 µL/s. | The agent's manifest still says 5 to 250, so it proposes a high flow rate. The driver refuses the write, says the operator lowered the limit, and sends nothing to the device. The agent reads the refusal and continues below 100. No fault counter runs, because a refusal is not a bench fault. |

Every demo ends the normal way: two successful experiments in a row confirm the optimum and the result is shown.

### Replaying a live run

A live run has the same replay machinery. **Replay this run** at the bottom of the event log plays the run's own
events from the start at the reading pace above, and **Stop replay and return to live** jumps back to the present.
Controls are disabled while a replay is playing.

### Recording a demo

Recording calls the model, so it needs a running server with the API key set. The script talks to
`http://localhost:3111` unless you pass another base URL as the second argument.

```bash
PORT=3111 bun run dev                  # terminal 1
bun scripts/record-demo.ts bubbles     # terminal 2: tip | clog | bubbles | limit [base url]
bun test                               # the demo story tests check that the new recording still tells its story
```

The script starts a run in auto mode, injects the fault (or lowers the limit) after the third completed experiment,
plays the human when the run escalates (guidance for bubbles, approval otherwise), and writes the whole event log,
with the title and description shown in the header, to `public/demos/<name>.json`. Re-record a demo after a prompt
change if its reasoning no longer tells the story; `tests/demos.test.ts` fails when it does not. The fixtures are
committed and served as static files.

## How it works

The event log is the only source of truth. The server appends events; the browser folds them into screen state
with a pure reducer (`src/shared/reducer.ts`). Replay is folding fewer events.

| Piece | File | What it does |
|---|---|---|
| Simulator + driver | `src/server/lab/bench.ts` | The fake bench and the MHS-style driver in front of it. The driver enforces the manifest ranges; only the driver can see the simulator. Faults are injected through a separate control channel the driver never sees. |
| Run loop | `src/server/loop.ts` | Deterministic code that turns a proposal into driver commands, waits for approval, evaluates results, and keeps the fault attempt counter. Aborts a run that reaches 30 experiments without concluding. |
| Agent | `src/server/agents/claude.ts` | One Claude call per turn, returning one JSON proposal. Claude chooses parameters; the loop operates the instruments. |
| Reviewer | `src/server/agents/reviewer.ts` | Three rules for auto mode. Never approves an escalation. |
| Runs and API | `src/server/runs.ts`, `src/server/index.ts` | In-memory runs, idempotent command endpoints, Server-Sent Events. Two browser tabs get two independent runs. |
| Interface | `src/client/App.tsx` | Everything on screen, in one file, including demo playback. |
| Demo recorder | `scripts/record-demo.ts`, `public/demos/*.json` | Records a real run against a running server as a fixture the browser replays. |

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

## Tests and evals

`bun test` is deterministic and never calls the model. The two guards worth knowing about: the prompt tests assert that
neither sample's hidden ideal flow rate nor RMSE floor ever appears in what the agent is sent, and the demo story tests
assert that each recorded demo still shows the reasoning it was recorded for.

`bun run eval` runs the real agent through six scenarios (both samples clean, the three faults, and the operator limit
change) with no instrument delays, plays the human on escalation, and scores each run: completes, finds the optimum
within 10% of the hidden floor, no out-of-range or third-replicate proposals, and per scenario the recovery behavior
(tip on attempt 1, clog by attempt 2 with reasoning that names the cause, a diagnosis on escalation and compliance with
guidance, the next proposal within a lowered limit). Each scenario runs twice (`EVAL_REPS` changes that). The limit is
lowered after the second experiment in its scenario so the sweep still has a high flow rate left for the driver to refuse.
The report goes to `evals/results/<date>.md` and every run's full event log to `evals/results/<date>/<scenario>-<rep>.json`,
so a failed run can be read afterwards. It is the check to run after any prompt change.

## Running it locally

```bash
bun install
cp .env.example .env   # then fill in the values
bun run dev            # builds the client, starts the server on http://localhost:3000
bun test               # 69 tests: simulator and driver, scoring, reducer, reviewer rules, prompt rendering and answer-leakage guards, run store, loop with a scripted agent, HTTP routes, demo story checks
bun run eval           # agent evals against the real model: six scenarios, two repetitions, about 100 Sonnet calls; writes evals/results/<date>.md and the transcripts beside it
bun run typecheck
```

Environment variables: `ANTHROPIC_API_KEY` (required for live runs, recording, and evals; not needed to play demos),
`ANTHROPIC_WORKSPACE_ID` (required for identity-linked keys), `AGENT_MODEL` (optional, default `claude-sonnet-5`),
`PORT` (optional, default 3000).

## Design decisions and tradeoffs

- **One JSON proposal per turn instead of driver tool calls.** Cheaper, faster, and one card shape in the interface. The cost is that Claude never calls the driver directly, so the driver-as-safety-boundary is shown at the parameter level: the operator-lowered limit demo shows the driver refusing the agent's write regardless of what the agent believes the range is. The faithful MHS form (tools generated from the driver manifest) is the first thing to add with more time.
- **No scripted fallback agent.** A demo where a heuristic quietly stands in for the model would mislead the reviewer. Failure is shown, and a human restarts.
- **Escalation cannot be dodged.** Rejected recovery proposals count toward the three attempts, and auto mode never approves an escalation.
- **Idempotent decisions.** A decision is accepted only for the hypothesis that is actually waiting. A stale click cannot approve the wrong experiment.
- **Two successes in a row end the run.** The confirmed parameters are written to `results/<run id>.json`, read back from disk, and shown in the interface, so the outcome of a run is a plain file another tool can pick up.
- **Demos are recordings, not scripts.** A recorded demo shows what the model actually did, and the story tests catch a recording that has drifted from the point it was made to show.

## With more time

Compile a successful recovery into a deterministic script and replay it with no model in the loop (the QuEra
result); seed history from other samples for the agent to read; a Haiku reviewer agent instead of rules; persist
runs in Turso; a zoomable timeline; more eval repetitions and scenarios.
