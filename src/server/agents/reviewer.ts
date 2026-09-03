/**
 * Rule-based reviewer used in auto mode. Three checks a careful lab tech would make before running an experiment.
 * It never sees an escalated proposal: those always go to a human.
 */
import type { ExperimentProposal, RunState } from "../../shared/types";

const FLOW_MIN = 5;
const FLOW_MAX = 250;
const MIXING_MAX = 10;
const MAX_JUMP_FROM_BEST = 4; // do not move more than 4x away from the best flow rate found so far

export function ruleBasedReview(p: ExperimentProposal, state: RunState): { accept: boolean; reason: string } {
  if (p.flow_rate_uL_per_s < FLOW_MIN || p.flow_rate_uL_per_s > FLOW_MAX || p.mixing_cycles < 0 || p.mixing_cycles > MIXING_MAX) {
    return { accept: false, reason: "Outside the driver's allowed range." };
  }

  // Only experiments that produced a measurement count as repeats; an errored one never ran.
  const repeats = state.experiments.filter(
    (x) => (x.status === "success" || x.status === "failure") && x.proposal.flow_rate_uL_per_s === p.flow_rate_uL_per_s && x.proposal.mixing_cycles === p.mixing_cycles,
  );
  if (repeats.length >= 2) {
    return { accept: false, reason: "These exact parameters have already been run twice." };
  }

  const faultActive = Boolean(state.fault?.active && state.fault.detected);
  const best = state.experiments.filter((x) => x.status === "success").sort((a, b) => a.rmse! - b.rmse!)[0];
  if (best && !faultActive) {
    const ratio = p.flow_rate_uL_per_s / best.proposal.flow_rate_uL_per_s;
    if (ratio > MAX_JUMP_FROM_BEST || ratio < 1 / MAX_JUMP_FROM_BEST) {
      return { accept: false, reason: `More than ${MAX_JUMP_FROM_BEST}x away from the best flow rate so far (${best.proposal.flow_rate_uL_per_s} uL/s).` };
    }
  }

  return { accept: true, reason: "Within range, not a repeat, and consistent with the results so far." };
}
