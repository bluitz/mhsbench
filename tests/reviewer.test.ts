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

describe("rule-based reviewer, edges", () => {
  test("the published range is inclusive at both ends", () => {
    expect(ruleBasedReview(proposal(5), stateWith([])).accept).toBe(true);
    expect(ruleBasedReview(proposal(250), stateWith([])).accept).toBe(true);
    expect(ruleBasedReview(proposal(4.9), stateWith([])).accept).toBe(false);
    expect(ruleBasedReview(proposal(250.1), stateWith([])).accept).toBe(false);
    expect(ruleBasedReview(proposal(50, 0), stateWith([])).accept).toBe(true);
    expect(ruleBasedReview(proposal(50, 10), stateWith([])).accept).toBe(true);
  });

  test("a previously rejected proposal does not count as a repeat", () => {
    const state = stateWith([
      { flow: 140, status: "rejected" },
      { flow: 140, status: "success", rmse: 0.016 },
    ]);
    expect(ruleBasedReview(proposal(140), state).accept).toBe(true);
  });

  test("the jump rule is anchored on the best success, not the most recent one", () => {
    const state = stateWith([
      { flow: 100, status: "success", rmse: 0.02 },
      { flow: 20, status: "success", rmse: 0.05 },
    ]);
    expect(ruleBasedReview(proposal(200), state).accept).toBe(true); // 2x from the best (100)
    expect(ruleBasedReview(proposal(15), state).accept).toBe(false); // more than 4x from the best, even though 20 is recent
  });

  test("an accepted proposal comes with a reason a human can read", () => {
    expect(ruleBasedReview(proposal(50), stateWith([])).reason).toBe("Within range, not a repeat, and consistent with the results so far.");
  });
});
