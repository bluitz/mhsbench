import { describe, expect, test } from "bun:test";
import { faultAttemptText, fold, initialState } from "../src/shared/reducer";
import type { ExperimentProposal, LabEvent } from "../src/shared/types";
import { GUIDANCE_PRESETS } from "../src/shared/types";

/** Build a log the way the server would, with increasing seq numbers. */
function log(entries: Array<[string, Record<string, unknown>, string?]>): LabEvent[] {
  return entries.map(([type, payload, experimentId], i) => ({
    seq: i + 1,
    ts: "2026-09-03T00:00:00.000Z",
    runId: "r1",
    actor: "run_loop",
    type,
    experimentId,
    payload,
  }));
}

const proposal: ExperimentProposal = { kind: "experiment", flow_rate_uL_per_s: 140, mixing_cycles: 2, tip: "keep", wells: "clean", rationale: "sweep" };

describe("fold", () => {
  test("rebuilds experiments, decisions, and results from the log", () => {
    const events = log([
      ["run.created", { fluidId: "water", autoMode: true }],
      ["hypothesis.proposed", { experimentId: "exp-1", proposal, escalation: false }, "exp-1"],
      ["hypothesis.accepted", { by: "reviewer", edits: { flow_rate_uL_per_s: 120 } }, "exp-1"],
      ["experiment.started", {}, "exp-1"],
      ["experiment.completed", { status: "success", rmse: 0.016, meanDelivered: 1, readings: [1, 1, 1, 1, 1, 1, 1, 1] }, "exp-1"],
      ["hypothesis.proposed", { experimentId: "exp-2", proposal, escalation: false }, "exp-2"],
      ["hypothesis.rejected", { by: "reviewer_agent", reason: "repeat" }, "exp-2"],
    ]);
    const state = fold("r1", "water", false, events);
    expect(state.fluidId).toBe("water");
    expect(state.autoMode).toBe(true);
    expect(state.experiments).toHaveLength(2);
    expect(state.experiments[0]!.status).toBe("success");
    expect(state.experiments[0]!.proposal.flow_rate_uL_per_s).toBe(120); // the reviewer's edit was applied
    expect(state.experiments[0]!.rmse).toBe(0.016);
    expect(state.experiments[1]!.status).toBe("rejected");
    expect(state.experiments[1]!.decisionReason).toBe("repeat");
    expect(state.pendingExperimentId).toBeNull();
    expect(state.markers).toEqual([{ tone: "reviewer", label: "Reviewer edited: flow 120", beforeIndex: 1 }]);
  });

  test("folding the same log twice gives the same state, so replay is exact", () => {
    const events = log([
      ["run.created", { fluidId: "bsa", autoMode: false }],
      ["hypothesis.proposed", { experimentId: "exp-1", proposal, escalation: false }, "exp-1"],
    ]);
    expect(fold("r1", "bsa", false, events)).toEqual(fold("r1", "bsa", false, events));
    expect(fold("r1", "bsa", false, events).pendingExperimentId).toBe("exp-1");
  });

  test("tracks a fault through detection, attempts, escalation, and recovery", () => {
    const events = log([
      ["run.created", { fluidId: "bsa", autoMode: true }],
      ["hypothesis.proposed", { experimentId: "exp-1", proposal, escalation: false }, "exp-1"],
      ["fault.injected", { fault: "bubbles" }],
      ["fault.detected", { signature: "E-217" }, "exp-1"],
      ["fault.attempt", { n: 1, max: 3 }],
      ["fault.attempt", { n: 2, max: 3 }],
      ["fault.attempt", { n: 3, max: 3 }],
      ["fault.escalated", { n: 3 }],
    ]);
    const state = fold("r1", "bsa", true, events);
    expect(state.fault).toEqual({ kind: "bubbles", active: true, detected: true, attempts: 3, escalated: true });
    expect(faultAttemptText(state)).toContain("A human reviewer must approve every step");
    // The fault marker sits above the experiment that was pending when it was injected.
    expect(state.markers[0]).toEqual({ tone: "fault", label: "Fault injected: Bubbles in the wells", beforeIndex: 1 });

    const recovered = fold("r1", "bsa", true, [...events, ...log([["fault.recovered", { attempts: 3 }]]).map((e) => ({ ...e, seq: 99 }))]);
    expect(recovered.fault?.active).toBe(false);
    expect(faultAttemptText(recovered)).toBeNull();
  });

  test("guidance and an operator limit change become markers before the next experiment", () => {
    const preset = GUIDANCE_PRESETS[0]!;
    const events = log([
      ["run.created", { fluidId: "bsa", autoMode: true }],
      ["hypothesis.proposed", { experimentId: "exp-1", proposal, escalation: false }, "exp-1"],
      ["experiment.completed", { status: "failure", rmse: 0.3, meanDelivered: 1 }, "exp-1"],
      ["guidance.provided", { text: preset.text }],
      ["guidance.provided", { text: "Try something completely different this time please thanks" }],
      ["limit.changed", { tag: "flow_rate_uL_per_s", max: 100 }],
    ]);
    const state = fold("r1", "bsa", true, events);
    expect(state.guidance).toHaveLength(2);
    expect(state.flowRateMax).toBe(100);
    expect(state.markers.map((m) => m.label)).toEqual([
      `Reviewer guidance: ${preset.label}`,
      "Reviewer guidance: Try something completely different this time…",
      "Operator lowered the flow-rate limit to 100 µL/s",
    ]);
    expect(state.markers.every((m) => m.beforeIndex === 2)).toBe(true);
  });

  test("records agent retries, failure, and the retry request", () => {
    const events = log([
      ["run.created", { fluidId: "water", autoMode: true }],
      ["agent.api_retry", { attempt: 1, maxAttempts: 5, delayMs: 2000, error: "boom" }],
      ["agent.failed", { error: "boom", attempts: 6 }],
      ["loop.stage_changed", { stage: "agent_error" }],
    ]);
    const failed = fold("r1", "water", true, events);
    expect(failed.retry).toBeNull();
    expect(failed.agentError).toEqual({ error: "boom", attempts: 6 });
    expect(failed.stage).toBe("agent_error");
    const resumed = fold("r1", "water", true, [...events, { ...events[0]!, seq: 5, type: "agent.retry_requested", payload: { by: "reviewer" } }]);
    expect(resumed.agentError).toBeNull();
  });

  test("keeps the device snapshot from the latest driver result and the saved result on completion", () => {
    const state = initialState("r1", "water", true);
    const devices = { ...state.devices, liquid_handler: { ...state.devices.liquid_handler, flow_rate_uL_per_s: 77 } };
    const events = log([
      ["driver.result", { device: "liquid_handler", action: "write flow_rate_uL_per_s", data: null, state: devices }],
      ["run.completed", { bestFlowRate: 140, bestRmse: 0.016, experiments: 8, confirmedBy: ["exp-7", "exp-8"], resultFile: "results/r1.json", resultJson: "{}" }],
    ]);
    const folded = fold("r1", "water", true, events);
    expect(folded.devices.liquid_handler.flow_rate_uL_per_s).toBe(77);
    expect(folded.result?.confirmedBy).toEqual(["exp-7", "exp-8"]);
    expect(folded.result?.resultFile).toBe("results/r1.json");
  });
});
