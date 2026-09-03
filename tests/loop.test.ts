/**
 * Tests for the research loop. Each test drives a real Run (simulator, driver, reducer, loop) with a fake
 * agent standing in for Claude, plays the human by calling the same methods the HTTP routes call, and checks
 * both the event log and the context the agent was handed. Sleep is a no-op, so a whole run takes milliseconds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Agent, AgentContext } from "../src/server/agents/claude";
import { runLoop } from "../src/server/loop";
import { Run } from "../src/server/runs";
import { fold } from "../src/shared/reducer";
import { GUIDANCE_PRESETS, MAX_EXPERIMENTS, type ExperimentProposal, type FluidId, type LabEvent, type Stage } from "../src/shared/types";

const WATER_IDEAL = 140;
const BSA_IDEAL = 10;
const FAR_FROM_IDEAL = 60; // water at 60 uL/s always fails the tolerance
const BUBBLES_GUIDANCE = GUIDANCE_PRESETS.find((g) => g.label.startsWith("bubbles"))!.text;
const SLOW_DOWN_GUIDANCE = GUIDANCE_PRESETS.find((g) => g.label === "slow down")!.text;

// ---------- The fake agent ----------

/** Stands in for Claude: answers from a queue and remembers every context it was handed. */
class FakeAgent implements Agent {
  contexts: AgentContext[] = [];
  constructor(private queue: Array<ExperimentProposal | Error>) {}

  async propose(context: AgentContext): Promise<ExperimentProposal> {
    this.contexts.push(context);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("The fake agent has run out of proposals.");
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A proposal at the given flow rate; keep the tip and reuse the wells unless told otherwise. */
function experiment(flowRate: number, overrides: Partial<ExperimentProposal> = {}): ExperimentProposal {
  return { kind: "experiment", flow_rate_uL_per_s: flowRate, mixing_cycles: 3, tip: "keep", wells: "current", rationale: "test", ...overrides };
}

const apiError = () => new Error("529 overloaded");

// ---------- Starting and stopping runs ----------

const noSleep = async () => {};
const liveRuns: Array<{ run: Run; done: Promise<void> }> = [];

function startRun(queue: Array<ExperimentProposal | Error>, fluid: FluidId = "water", autoMode = false) {
  const agent = new FakeAgent(queue);
  const run = new Run(`test-${crypto.randomUUID().slice(0, 8)}`, fluid, autoMode);
  const done = runLoop(run, agent, { sleep: noSleep });
  liveRuns.push({ run, done });
  return { run, agent, done };
}

// Every run is stopped after its test, and the results file a completed run wrote is removed.
afterEach(async () => {
  for (const { run, done } of liveRuns.splice(0)) {
    if (!run.ended) run.abort("test finished");
    await done;
    await unlink(`results/${run.id}.json`).catch(() => {});
  }
});

// ---------- Reading the run ----------

const state = (run: Run) => fold(run.id, run.fluidId, run.autoMode, run.events);
const eventsOfType = (run: Run, type: string) => run.events.filter((e) => e.type === type);
const stages = (run: Run): Stage[] => eventsOfType(run, "loop.stage_changed").map((e) => e.payload.stage as Stage);

/** Resolve with the first non-null answer, checking now and again after every new event. */
function waitFor<T>(run: Run, look: () => T | null): Promise<T> {
  const now = look();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const subscriber = () => {
      const answer = look();
      if (answer === null) return;
      run.subscribers.delete(subscriber);
      resolve(answer);
    };
    run.subscribers.add(subscriber);
  });
}

/** The hypothesis a human is being asked to decide on right now, if any. */
function waitingHypothesis(run: Run): string | null {
  const s = state(run);
  const waiting = s.stage === "awaiting_approval" || s.stage === "awaiting_human";
  return waiting ? s.pendingExperimentId : null;
}

const waitForHypothesis = (run: Run) => waitFor(run, () => waitingHypothesis(run));
const waitForStage = (run: Run, stage: Stage) => waitFor(run, () => (state(run).stage === stage ? stage : null));
const completedExperiment = (run: Run, id: string) => run.events.find((e) => e.type === "experiment.completed" && e.experimentId === id) ?? null;

// ---------- Playing the human ----------

/** Wait for the next hypothesis, accept it, and wait for its experiment to finish. */
async function approve(run: Run, edits?: Partial<ExperimentProposal>): Promise<LabEvent> {
  const id = await waitForHypothesis(run);
  const result = run.decide(id, edits ? { decision: "accept", edits } : { decision: "accept" });
  expect(result.ok).toBe(true);
  return waitFor(run, () => completedExperiment(run, id));
}

/** Wait for the next hypothesis and reject it. */
async function reject(run: Run, reason: string): Promise<string> {
  const id = await waitForHypothesis(run);
  const result = run.decide(id, { decision: "reject", reason });
  expect(result.ok).toBe(true);
  return id;
}

// ---------- Tests ----------

describe("main path", () => {
  test("two successes in a row complete the run, and an edit changes what actually ran", async () => {
    const { run, done } = startRun([experiment(WATER_IDEAL), experiment(WATER_IDEAL)]);

    const first = await approve(run);
    expect(first.payload.status).toBe("success");

    // The reviewer edits mixing cycles to 0 before accepting; the experiment runs with that value.
    const second = await approve(run, { mixing_cycles: 0 });
    expect(second.payload.status).toBe("success");
    const started = eventsOfType(run, "experiment.started").find((e) => e.experimentId === second.experimentId)!;
    expect((started.payload.params as ExperimentProposal).mixing_cycles).toBe(0);

    await done;
    const completed = eventsOfType(run, "run.completed")[0]!;
    expect(completed.payload).toMatchObject({ bestFlowRate: WATER_IDEAL, experiments: 2, confirmedBy: ["exp-1", "exp-2"] });
    expect(await Bun.file(`results/${run.id}.json`).exists()).toBe(true);
    expect(stages(run)).toEqual([
      "reviewing_history", "proposing", "awaiting_approval", "running", "evaluating",
      "reviewing_history", "proposing", "awaiting_approval", "running", "evaluating",
      "complete",
    ]);
  });
});

describe("faults", () => {
  test("a clogged tip is detected, escalates after three attempts, and recovers when a human approves a tip replacement", async () => {
    const { run, agent, done } = startRun([
      experiment(WATER_IDEAL), // clean baseline
      experiment(WATER_IDEAL), // the clog shows up here: attempt 1
      experiment(70), // wrong fix, a flow rate change: attempt 2
      experiment(WATER_IDEAL), // wrong fix again: attempt 3, escalates
      experiment(WATER_IDEAL, { tip: "replace", diagnosis: "Delivery stays at half regardless of flow rate, so the tip is clogged." }),
      experiment(WATER_IDEAL), // confirmation, the run completes
    ]);

    await approve(run);
    expect(run.injectFault("clogged_tip").ok).toBe(true);

    // Detection: the first under-delivery is logged and counts as attempt 1.
    const symptom = await approve(run);
    expect(symptom.payload.meanDelivered as number).toBeLessThan(0.7);
    expect(eventsOfType(run, "fault.detected")[0]!.payload).toMatchObject({ signature: "under_delivery", fault: "clogged_tip" });
    expect(eventsOfType(run, "fault.attempt").map((e) => e.payload.n)).toEqual([1]);
    expect(agent.contexts[2]!.fault).toEqual({ attempts: 1, maxAttempts: 3, escalated: false });

    // Two failed fixes reach the limit and escalate.
    await approve(run);
    await approve(run);
    expect(eventsOfType(run, "fault.attempt").map((e) => e.payload.n)).toEqual([1, 2, 3]);
    expect(eventsOfType(run, "fault.escalated")[0]!.payload.n).toBe(3);
    expect(state(run).fault).toEqual({ kind: "clogged_tip", active: true, detected: true, attempts: 3, escalated: true });

    // The next proposal is an escalation: flagged, waiting for a human, and the agent was told.
    const escalatedId = await waitForHypothesis(run);
    expect(state(run).stage).toBe("awaiting_human");
    expect(state(run).experiments.find((x) => x.id === escalatedId)!.escalation).toBe(true);
    expect(agent.contexts[4]!.fault).toEqual({ attempts: 3, maxAttempts: 3, escalated: true });

    // Approving the tip replacement ejects and picks up, delivery returns to normal, and the fault is recovered.
    const proposed = eventsOfType(run, "hypothesis.proposed").find((e) => e.experimentId === escalatedId)!;
    const recovered = await approve(run);
    const actions = eventsOfType(run, "driver.command").filter((e) => e.seq > proposed.seq).map((e) => e.payload.action);
    expect(actions.slice(0, 2)).toEqual(["eject_tip", "pick_up_tip"]);
    expect(recovered.payload.meanDelivered as number).toBeGreaterThan(0.9);
    expect(eventsOfType(run, "fault.recovered")[0]!.payload.attempts).toBe(3);
    expect(state(run).fault!.active).toBe(false);

    // After recovery, proposals are ordinary again and the run completes.
    await approve(run);
    await done;
    expect(state(run).experiments.at(-1)!.escalation).toBe(false);
    expect(eventsOfType(run, "run.completed")).toHaveLength(1);
  });

  test("rejected recovery proposals count toward escalation, so a reject loop cannot dodge it", async () => {
    const { run } = startRun([
      experiment(WATER_IDEAL), // baseline
      experiment(WATER_IDEAL), // the symptom: attempt 1
      experiment(WATER_IDEAL), // rejected without running: attempt 2
      experiment(WATER_IDEAL), // rejected without running: attempt 3, escalates
      experiment(WATER_IDEAL, { tip: "replace", diagnosis: "clog" }),
    ]);
    await approve(run);
    run.injectFault("clogged_tip");
    await approve(run);

    await reject(run, "Try replacing the tip instead.");
    await reject(run, "Still not addressing the tip.");
    const escalatedId = await waitForHypothesis(run);

    expect(eventsOfType(run, "fault.attempt").map((e) => e.payload.n)).toEqual([1, 2, 3]);
    expect(eventsOfType(run, "fault.escalated")).toHaveLength(1);
    expect(eventsOfType(run, "experiment.completed")).toHaveLength(2); // nothing ran while rejecting
    expect(state(run).stage).toBe("awaiting_human");
    expect(state(run).experiments.find((x) => x.id === escalatedId)!.escalation).toBe(true);
  });

  test("bubbles resist the right recipe until a human is in the loop, then clear after guidance", async () => {
    const cleanAndGentle = { wells: "clean" as const, mixing_cycles: 1 };
    const { run, agent, done } = startRun(
      [
        experiment(BSA_IDEAL), // baseline
        experiment(BSA_IDEAL, cleanAndGentle), // the right recipe, but no human in the loop yet: attempt 1
        experiment(BSA_IDEAL, { wells: "clean", mixing_cycles: 0 }), // attempt 2
        experiment(BSA_IDEAL, cleanAndGentle), // attempt 3, escalates
        experiment(BSA_IDEAL, cleanAndGentle), // superseded by guidance, never runs
        experiment(BSA_IDEAL, { ...cleanAndGentle, diagnosis: "Bubbles from mixing; use clean wells and gentle mixing." }),
        experiment(BSA_IDEAL), // confirmation, the run completes
      ],
      "bsa",
    );

    await approve(run);
    run.injectFault("bubbles");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await approve(run);
      expect(result.payload).toMatchObject({ status: "error", errorCode: "E-217" });
    }
    expect(eventsOfType(run, "fault.escalated")).toHaveLength(1);
    expect(agent.contexts[2]!.driverErrors.at(-1)).toContain("E-217");

    // The human names the physical cause: the escalated proposal is superseded and the agent re-plans with it.
    await waitForHypothesis(run);
    run.provideGuidance(BUBBLES_GUIDANCE);
    const recovered = await approve(run);
    expect(recovered.payload.status).toBe("success");
    expect(agent.contexts[5]!.guidance).toEqual([BUBBLES_GUIDANCE]);
    expect(eventsOfType(run, "fault.recovered")).toHaveLength(1);
    expect(eventsOfType(run, "fault.attempt")).toHaveLength(3); // the superseded proposal cost nothing

    await approve(run);
    await done;
    expect(eventsOfType(run, "run.completed")).toHaveLength(1);
  });
});

describe("human guidance", () => {
  test("guidance supersedes the waiting hypothesis, costs no attempt, and stays in the agent's context", async () => {
    const { run, agent } = startRun([experiment(WATER_IDEAL), experiment(100), experiment(100)]);
    const first = await waitForHypothesis(run);

    expect(run.provideGuidance(SLOW_DOWN_GUIDANCE).ok).toBe(true);
    const superseded = eventsOfType(run, "hypothesis.rejected").find((e) => e.experimentId === first)!;
    expect(superseded.payload.reason).toBe("Superseded by reviewer guidance");
    expect(eventsOfType(run, "fault.attempt")).toHaveLength(0);

    const second = await waitForHypothesis(run);
    expect(second).not.toBe(first);
    expect(agent.contexts[1]!.guidance).toEqual([SLOW_DOWN_GUIDANCE]);
    expect(state(run).guidance).toEqual([SLOW_DOWN_GUIDANCE]);

    await approve(run);
    await waitForHypothesis(run);
    expect(agent.contexts[2]!.guidance).toEqual([SLOW_DOWN_GUIDANCE]); // still there a turn later
  });
});

describe("agent failure", () => {
  test("five backoff retries, then the run pauses until a human retries", async () => {
    const { run, agent } = startRun([...Array.from({ length: 6 }, apiError), experiment(WATER_IDEAL)]);
    expect(run.retry().ok).toBe(false); // nothing to retry yet: the agent is still being called

    await waitForStage(run, "agent_error");
    const retries = eventsOfType(run, "agent.api_retry");
    expect(retries.map((e) => e.payload.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(retries.map((e) => e.payload.delayMs)).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(eventsOfType(run, "agent.failed")[0]!.payload).toMatchObject({ attempts: 6, error: "529 overloaded" });
    expect(state(run).agentError).toEqual({ error: "529 overloaded", attempts: 6 });
    expect(eventsOfType(run, "hypothesis.proposed")).toHaveLength(0);

    // A human presses Retry agent: the loop proposes again with the same context.
    expect(run.retry().ok).toBe(true);
    expect(await waitForHypothesis(run)).toBe("exp-1");
    expect(eventsOfType(run, "agent.retry_requested")).toHaveLength(1);
    expect(state(run).agentError).toBeNull();
    expect(agent.contexts).toHaveLength(7);
  });
});

describe("abort", () => {
  test("aborting while a hypothesis waits ends the loop without running anything", async () => {
    const { run, done } = startRun([experiment(WATER_IDEAL)]);
    await waitForHypothesis(run);
    expect(run.abort("Operator stopped the run.").ok).toBe(true);
    await done;
    expect(eventsOfType(run, "run.aborted")[0]!.payload.reason).toBe("Operator stopped the run.");
    expect(state(run).stage).toBe("aborted");
    expect(eventsOfType(run, "experiment.started")).toHaveLength(0);
    expect(run.ended).toBe(true);
  });

  test("aborting while the agent is down also ends the loop", async () => {
    const { run, agent, done } = startRun(Array.from({ length: 6 }, apiError));
    await waitForStage(run, "agent_error");
    run.abort("Give up.");
    await done;
    expect(state(run).abortReason).toBe("Give up.");
    expect(agent.contexts).toHaveLength(6); // no further proposals after the abort
  });
});

describe("auto mode", () => {
  test("the reviewer agent approves sound proposals and rejects a third identical run", async () => {
    const { run, done } = startRun(
      [
        experiment(FAR_FROM_IDEAL), experiment(FAR_FROM_IDEAL), experiment(FAR_FROM_IDEAL), // the third is a repeat
        experiment(WATER_IDEAL), experiment(WATER_IDEAL),
      ],
      "water",
      true,
    );
    await done;

    const decisions = run.events.filter((e) => e.type === "hypothesis.accepted" || e.type === "hypothesis.rejected");
    expect(decisions.every((e) => e.actor === "reviewer_agent")).toBe(true);
    expect(decisions.map((e) => e.type)).toEqual([
      "hypothesis.accepted", "hypothesis.accepted", "hypothesis.rejected", "hypothesis.accepted", "hypothesis.accepted",
    ]);
    expect(decisions[2]!.payload.reason).toContain("already been run twice");
    expect(stages(run)).not.toContain("awaiting_approval");
    expect(eventsOfType(run, "run.completed")).toHaveLength(1);
  });

  test("an escalation still waits for a human in auto mode, then the reviewer agent takes over again", async () => {
    const { run, done } = startRun(
      [
        experiment(100), experiment(120), experiment(130), // clogged from the start: attempts 1, 2, 3
        experiment(WATER_IDEAL, { tip: "replace", diagnosis: "clog" }),
        experiment(WATER_IDEAL),
      ],
      "water",
      true,
    );
    run.injectFault("clogged_tip"); // lands before the first experiment runs

    const escalatedId = await waitForHypothesis(run);
    expect(escalatedId).toBe("exp-4");
    expect(state(run).stage).toBe("awaiting_human");
    expect(eventsOfType(run, "fault.escalated")).toHaveLength(1);
    expect(run.events.some((e) => e.actor === "reviewer_agent" && e.experimentId === "exp-4")).toBe(false);

    expect(run.decide(escalatedId, { decision: "accept" }).ok).toBe(true);
    await done;
    expect(eventsOfType(run, "fault.recovered")).toHaveLength(1);
    expect(eventsOfType(run, "hypothesis.accepted").at(-1)).toMatchObject({ actor: "reviewer_agent", experimentId: "exp-5" });
    expect(eventsOfType(run, "run.completed")).toHaveLength(1);
  });
});

describe("decisions", () => {
  test("a decision is accepted only for the waiting hypothesis, and repeating it is harmless", async () => {
    const { run } = startRun([experiment(WATER_IDEAL), experiment(WATER_IDEAL)]);
    const id = await waitForHypothesis(run);

    expect(run.decide("exp-99", { decision: "accept" })).toMatchObject({ ok: false, status: 409 });
    const first = run.decide(id, { decision: "accept" });
    expect(first).toEqual({ ok: true, seq: expect.any(Number) });
    expect(run.decide(id, { decision: "accept" })).toEqual(first); // a double click returns the original
    expect(run.decide(id, { decision: "reject", reason: "changed my mind" })).toMatchObject({ ok: false, status: 409 });
    expect(eventsOfType(run, "hypothesis.accepted")).toHaveLength(1);
  });
});

describe("limits", () => {
  test("the run is aborted at the maximum number of experiments", async () => {
    // Distinct flow rates that all fail, so the reviewer agent never sees a repeat and nothing ever succeeds.
    const proposals = Array.from({ length: MAX_EXPERIMENTS + 1 }, (_, i) => experiment(20 + i));
    const { run, done } = startRun(proposals, "water", true);
    await done;
    expect(eventsOfType(run, "experiment.completed")).toHaveLength(MAX_EXPERIMENTS);
    expect(state(run).abortReason).toContain(`maximum of ${MAX_EXPERIMENTS}`);
  });
});
