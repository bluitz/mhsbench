import { describe, expect, test } from "bun:test";
import { ruleBasedReview } from "../src/server/agents/reviewer";
import { initialState } from "../src/shared/reducer";
import type { ExperimentProposal, ExperimentStatus, RunState } from "../src/shared/types";

function proposal(flow: number, mixing = 2): ExperimentProposal {
  return { kind: "experiment", flow_rate_uL_per_s: flow, mixing_cycles: mixing, tip: "keep", wells: "current", rationale: "" };
}

/** A run state with some finished experiments, without running anything. */
function stateWith(results: Array<{ flow: number; status: ExperimentStatus; rmse?: number; mixing?: number }>): RunState {
  const state = initialState("r1", "water", true);
  state.experiments = results.map((r, i) => ({
    id: `exp-${i + 1}`,
    index: i + 1,
    proposal: proposal(r.flow, r.mixing ?? 2),
    status: r.status,
    escalation: false,
    rmse: r.rmse,
  }));
  return state;
}

describe("rule-based reviewer", () => {
  test("rejects anything outside the driver's published range", () => {
    expect(ruleBasedReview(proposal(300), stateWith([])).accept).toBe(false);
    expect(ruleBasedReview(proposal(2), stateWith([])).accept).toBe(false);
    expect(ruleBasedReview(proposal(50, 11), stateWith([])).accept).toBe(false);
  });

  test("allows a replicate but not a third run of the same parameters", () => {
    const twice = stateWith([
      { flow: 140, status: "success", rmse: 0.016 },
      { flow: 140, status: "success", rmse: 0.017 },
    ]);
    expect(ruleBasedReview(proposal(140), stateWith([{ flow: 140, status: "success", rmse: 0.016 }])).accept).toBe(true);
    expect(ruleBasedReview(proposal(140), twice).reason).toContain("already been run twice");
  });

  test("an errored experiment does not count as a repeat, because it never measured anything", () => {
    const state = stateWith([
      { flow: 140, status: "error" },
      { flow: 140, status: "success", rmse: 0.016 },
    ]);
    expect(ruleBasedReview(proposal(140), state).accept).toBe(true);
  });

  test("rejects a jump of more than 4x from the best flow rate, unless a fault is being handled", () => {
    const state = stateWith([{ flow: 100, status: "success", rmse: 0.02 }]);
    expect(ruleBasedReview(proposal(20), state).reason).toContain("4x away");
    expect(ruleBasedReview(proposal(30), state).accept).toBe(true);
    state.fault = { kind: "clogged_tip", active: true, detected: true, attempts: 1, escalated: false };
    expect(ruleBasedReview(proposal(20), state).accept).toBe(true);
  });
});
