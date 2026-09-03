import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Agent } from "../src/server/agents/claude";
import { runLoop } from "../src/server/loop";
import { Run } from "../src/server/runs";
import { fold } from "../src/shared/reducer";
import type { ExperimentProposal } from "../src/shared/types";

// The loop's simulated instrument time and retry backoff are skipped entirely.
const noWait = { sleep: async () => {} };

function experiment(flow: number, extra: Partial<ExperimentProposal> = {}): ExperimentProposal {
  return { kind: "experiment", flow_rate_uL_per_s: flow, mixing_cycles: 3, tip: "keep", wells: "clean", rationale: "scripted", ...extra };
}

/** An agent that follows a script: one entry per call, the last entry repeats. */
function scripted(steps: Array<ExperimentProposal | Error | (() => ExperimentProposal)>): Agent {
  let call = 0;
  return {
    async propose() {
      const step = steps[Math.min(call, steps.length - 1)]!;
      call += 1;
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step() : step;
    },
  };
}

async function waitFor(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

const types = (run: Run) => run.events.map((e) => e.type);
const state = (run: Run) => fold(run.id, run.fluidId, run.autoMode, run.events);
const cleanup = (run: Run) => unlink(`results/${run.id}.json`).catch(() => {});

describe("run loop", () => {
  test("two successes in a row end the run and save the parameters to a file", async () => {
    const run = new Run("loop-1", "water", true);
    await runLoop(run, scripted([experiment(140)]), noWait);

    const done = state(run);
    expect(done.stage).toBe("complete");
    expect(done.experiments.map((x) => x.status)).toEqual(["success", "success"]);
    expect(done.result?.bestFlowRate).toBe(140);
    expect(done.result?.confirmedBy).toEqual(["exp-1", "exp-2"]);
    const saved = JSON.parse(done.result!.resultJson);
    expect(saved.optimal_parameters.flow_rate_uL_per_s).toBe(140);
    expect(await Bun.file(`results/${run.id}.json`).exists()).toBe(true);
    await cleanup(run);
  });

  test("bubbles escalate after three attempts, and a human edit to gentle mixing recovers", async () => {
    const run = new Run("loop-2", "bsa", true);
    // The agent keeps proposing the ideal flow rate with vigorous mixing. Bubbles are injected before its second proposal.
    const agent = scripted([experiment(10), () => (run.injectFault("bubbles"), experiment(10)), experiment(10)]);
    const loop = runLoop(run, agent, noWait);

    await waitFor(() => types(run).includes("fault.escalated"));
    await waitFor(() => state(run).stage === "awaiting_human");
    const pending = state(run).pendingExperimentId!;
    expect(state(run).experiments.find((x) => x.id === pending)?.escalation).toBe(true);
    expect(state(run).fault?.attempts).toBe(3);

    run.decide(pending, { decision: "accept", edits: { mixing_cycles: 1, wells: "clean" } });
    await loop;

    const done = state(run);
    expect(types(run)).toContain("fault.recovered");
    expect(done.fault?.active).toBe(false);
    expect(done.stage).toBe("complete");
    expect(done.markers.some((m) => m.label === "Reviewer edited: mixing 1, wells clean")).toBe(true);
    await cleanup(run);
  });

  test("after a minute of agent failures the run pauses until a human retries", async () => {
    const run = new Run("loop-3", "water", true);
    const boom = new Error("API down");
    const agent = scripted([boom, boom, boom, boom, boom, boom, experiment(140)]);
    const loop = runLoop(run, agent, noWait);

    await waitFor(() => state(run).stage === "agent_error");
    expect(types(run).filter((t) => t === "agent.api_retry")).toHaveLength(5);
    expect(state(run).agentError?.error).toBe("API down");

    expect(run.retry().ok).toBe(true);
    await loop;
    expect(state(run).stage).toBe("complete");
    await cleanup(run);
  });

  test("in manual mode the driver refuses an out-of-range write the human let through", async () => {
    const run = new Run("loop-4", "water", false);
    const agent = scripted([experiment(300), experiment(140)]);
    const loop = runLoop(run, agent, noWait);

    // Play the human: accept every hypothesis as it arrives.
    const decided = new Set<string>();
    while (!run.ended) {
      await waitFor(() => run.ended || state(run).pendingExperimentId !== null);
      const id = state(run).pendingExperimentId;
      if (id && !decided.has(id)) {
        decided.add(id);
        run.decide(id, { decision: "accept" });
      }
    }
    await loop;

    const done = state(run);
    expect(done.experiments[0]!.status).toBe("error");
    expect(done.experiments[0]!.errorCode).toBe("DRIVER_REJECTED");
    expect(types(run)).toContain("driver.rejected");
    expect(types(run)).not.toContain("fault.detected"); // a refused write is not a bench fault
    expect(done.result?.bestFlowRate).toBe(140);
    await cleanup(run);
  });
});
