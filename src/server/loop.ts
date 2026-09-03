/**
 * The research loop: review history -> propose -> approve -> run -> evaluate -> repeat.
 * Deterministic server code. The agent only chooses parameters; this file operates the instruments.
 * All state is read back from the event log (fold), so the log is the single source of truth.
 */
import { FLUID_CARDS } from "../shared/fluids";
import { fold } from "../shared/reducer";
import { meanDeliveredOf, rmseOf } from "../shared/score";
import type { ExperimentProposal, ExperimentStatus, ExperimentView, FluidCard, RunState, Stage } from "../shared/types";
import { MAX_EXPERIMENTS, MAX_FAULT_ATTEMPTS } from "../shared/types";
import type { AgentContext, Agent } from "./agents/claude";
import { ruleBasedReview } from "./agents/reviewer";
import { manifestText, type DriverResult } from "./lab/bench";
import type { Run } from "./runs";

// Simulated instrument time so the run is watchable from across the room.
const INSTRUMENT_MS = { pickUpTip: 400, transfer: 1000, mix: 500, read: 700, betweenExperiments: 500 };
// Retry schedule after a Claude API error: about one minute in total, then a human must step in.
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
// Mean delivered fraction below this means the tip is under-delivering (a clog), whatever the flow rate.
const UNDER_DELIVERY = 0.8;

export interface LoopOptions {
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLoop(run: Run, agent: Agent, options: LoopOptions = { sleep: realSleep }): Promise<void> {
  const fluid = FLUID_CARDS[run.fluidId];
  const stage = (s: Stage) => run.emit("run_loop", "loop.stage_changed", { stage: s });
  const currentState = (): RunState => fold(run.id, run.fluidId, run.autoMode, run.events);

  run.emit("run_loop", "run.created", { fluidId: run.fluidId, autoMode: run.autoMode });
  let proposalCount = 0;

  while (!run.aborted) {
    stage("reviewing_history");
    const state = currentState();
    const faultActive = Boolean(state.fault?.active && state.fault.detected);
    const escalated = faultActive && Boolean(state.fault?.escalated);

    stage("proposing");
    const proposal = await proposeWithRetries(run, agent, buildContext(fluid, state, run), options);
    if (run.aborted) break;
    if (!proposal) {
      stage("agent_error");
      await run.waitForRetry();
      continue;
    }

    if (proposalCount >= MAX_EXPERIMENTS) {
      run.abort(`Reached the maximum of ${MAX_EXPERIMENTS} experiments without concluding.`);
      break;
    }
    proposalCount += 1;
    const experimentId = `exp-${proposalCount}`;
    run.emit("agent", "hypothesis.proposed", { experimentId, proposal, escalation: escalated, source: "claude" }, experimentId);

    // Approval: a human decides, unless auto mode is on. Escalations always wait for a human.
    let decision;
    if (escalated || !run.autoMode) {
      stage(escalated ? "awaiting_human" : "awaiting_approval");
      decision = await run.waitForDecision(experimentId);
    } else {
      stage("reviewing");
      await options.sleep(600);
      const review = ruleBasedReview(proposal, state);
      decision = { decision: review.accept ? "accept" : "reject", reason: review.reason } as const;
      run.emit("reviewer_agent", review.accept ? "hypothesis.accepted" : "hypothesis.rejected", { by: "reviewer_agent", reason: review.reason, edits: null }, experimentId);
    }
    if (run.aborted) break;

    if (decision.decision !== "accept") {
      // A rejected recovery attempt still counts toward the limit, so a reject loop cannot dodge escalation.
      if (decision.decision === "reject" && faultActive) recordFaultAttempt(run, currentState());
      continue;
    }

    const finalProposal: ExperimentProposal = { ...proposal, ...(decision.edits ?? {}) };
    stage("running");
    run.emit("run_loop", "experiment.started", { params: finalProposal }, experimentId);
    const outcome = await executeExperiment(run, finalProposal, options);

    stage("evaluating");
    const status: ExperimentStatus = outcome.error ? "error" : outcome.rmse! <= fluid.tolerance ? "success" : "failure";
    run.emit("run_loop", "experiment.completed", { status, rmse: outcome.rmse ?? null, meanDelivered: outcome.meanDelivered ?? null, readings: outcome.readings ?? null, errorCode: outcome.error ?? null, errorMessage: outcome.message ?? null }, experimentId);

    updateFaultBookkeeping(run, outcome, experimentId);

    // Two successful experiments in a row confirm the optimum and end the run.
    const measured = currentState().experiments.filter((x) => x.status !== "rejected");
    const lastTwo = measured.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((x) => x.status === "success")) {
      await completeRun(run, fluid, lastTwo, measured.length);
      stage("complete");
      run.ended = true;
      return;
    }
    await options.sleep(INSTRUMENT_MS.betweenExperiments);
  }
}

/** Save the confirmed parameters to a JSON file, read the file back, and announce the result. */
async function completeRun(run: Run, fluid: FluidCard, confirming: ExperimentView[], experimentCount: number) {
  const best = confirming.reduce((a, b) => (a.rmse! <= b.rmse! ? a : b));
  const result = {
    run_id: run.id,
    sample: fluid.name,
    completed_at: new Date().toISOString(),
    optimal_parameters: {
      flow_rate_uL_per_s: best.proposal.flow_rate_uL_per_s,
      mixing_cycles: best.proposal.mixing_cycles,
    },
    best_rmse: best.rmse,
    assay_tolerance: fluid.tolerance,
    confirmed_by_experiments: confirming.map((x) => ({ id: x.id, flow_rate_uL_per_s: x.proposal.flow_rate_uL_per_s, rmse: x.rmse })),
    experiments_run: experimentCount,
  };
  const resultFile = `results/${run.id}.json`;
  await Bun.write(resultFile, JSON.stringify(result, null, 2));
  const resultJson = await Bun.file(resultFile).text();
  run.emit("run_loop", "run.completed", {
    bestFlowRate: best.proposal.flow_rate_uL_per_s,
    bestRmse: best.rmse,
    experiments: experimentCount,
    confirmedBy: confirming.map((x) => x.id),
    resultFile,
    resultJson,
  });
}

// ---------- Agent call with backoff ----------

async function proposeWithRetries(run: Run, agent: Agent, context: AgentContext, options: LoopOptions): Promise<ExperimentProposal | null> {
  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt++) {
    try {
      return await agent.propose(context);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const delayMs = BACKOFF_MS[attempt - 1];
      if (delayMs === undefined) {
        run.emit("agent", "agent.failed", { error, attempts: attempt });
        return null;
      }
      run.emit("agent", "agent.api_retry", { attempt, maxAttempts: BACKOFF_MS.length, delayMs, error });
      await options.sleep(delayMs);
      if (run.aborted) return null;
    }
  }
  return null;
}

// ---------- Context the agent sees ----------

function buildContext(fluid: FluidCard, state: RunState, run: Run): AgentContext {
  const driverErrors = run.events
    .filter((e) => e.type === "driver.error" || e.type === "driver.rejected")
    .slice(-3)
    .map((e) => `${e.payload.action}: ${e.payload.code ?? "DRIVER_REJECTED"} ${e.payload.message}`);
  return {
    fluid,
    manifest: manifestText(),
    experiments: state.experiments,
    guidance: state.guidance,
    fault: state.fault && state.fault.active && state.fault.detected
      ? { attempts: state.fault.attempts, maxAttempts: MAX_FAULT_ATTEMPTS, escalated: state.fault.escalated }
      : null,
    driverErrors,
  };
}

// ---------- Running one experiment on the bench ----------

interface Outcome {
  readings?: number[];
  rmse?: number;
  meanDelivered?: number;
  error?: string;
  message?: string;
}

async function executeExperiment(run: Run, p: ExperimentProposal, options: LoopOptions): Promise<Outcome> {
  const d = run.driver;
  const failed = (r: DriverResult): Outcome => ({ error: r.code, message: r.message });
  let r: DriverResult;

  // Tip handling. 'replace' discards the current tip; any pickup after a failure moves to the next rack position.
  if (p.tip === "replace" && d.snapshot().liquid_handler.tip_attached) {
    r = d.call("liquid_handler", "eject_tip");
    if (!r.ok) return failed(r);
  }
  if (!d.snapshot().liquid_handler.tip_attached) {
    await options.sleep(INSTRUMENT_MS.pickUpTip);
    r = d.call("liquid_handler", "pick_up_tip", { position: p.tip === "keep" ? "same" : "next" });
    if (!r.ok) return failed(r);
  }
  if (p.wells === "clean") {
    r = d.call("liquid_handler", "move_to_clean_wells");
    if (!r.ok) return failed(r);
  }

  // Parameters. The driver rejects anything outside the manifest's range before it reaches the device.
  r = d.write("liquid_handler", "flow_rate_uL_per_s", p.flow_rate_uL_per_s);
  if (!r.ok) return failed(r);
  r = d.write("liquid_handler", "mixing_cycles", p.mixing_cycles);
  if (!r.ok) return failed(r);

  // The transfer itself, then the measurement.
  await options.sleep(INSTRUMENT_MS.transfer);
  r = d.call("liquid_handler", "transfer");
  if (!r.ok) return failed(r);
  if (p.mixing_cycles > 0) {
    await options.sleep(INSTRUMENT_MS.mix);
    r = d.call("liquid_handler", "mix");
    if (!r.ok) return failed(r);
  }
  await options.sleep(INSTRUMENT_MS.read);
  r = d.call("plate_reader", "read_absorbance");
  if (!r.ok) return failed(r);

  const readings = r.data!.readings as number[];
  return { readings, rmse: rmseOf(readings), meanDelivered: meanDeliveredOf(readings) };
}

// ---------- Fault bookkeeping ----------

function updateFaultBookkeeping(run: Run, outcome: Outcome, experimentId: string) {
  const state = fold(run.id, run.fluidId, run.autoMode, run.events);
  const stillActive = run.control.activeFault() !== null;
  const symptom = outcome.error !== undefined || (outcome.meanDelivered !== undefined && outcome.meanDelivered < UNDER_DELIVERY);

  if (!run.faultInjected) return;

  if (!stillActive) {
    // Whatever the agent just did cleared the fault (or it never showed a symptom).
    run.emit("run_loop", "fault.recovered", { attempts: state.fault?.attempts ?? 0 });
    run.faultInjected = false;
    run.control.setHumanInLoop(false);
    return;
  }
  if (!symptom) return; // fault armed but not yet visible (e.g. tip failure waits for the next pickup)

  if (!state.fault?.detected) {
    const signature = outcome.error ?? "under_delivery";
    run.emit("run_loop", "fault.detected", { signature, fault: run.control.activeFault() }, experimentId);
  }
  recordFaultAttempt(run, fold(run.id, run.fluidId, run.autoMode, run.events));
}

function recordFaultAttempt(run: Run, state: RunState) {
  const n = (state.fault?.attempts ?? 0) + 1;
  run.emit("run_loop", "fault.attempt", { n, max: MAX_FAULT_ATTEMPTS });
  if (n >= MAX_FAULT_ATTEMPTS && !state.fault?.escalated) {
    run.control.setHumanInLoop(true);
    run.emit("run_loop", "fault.escalated", { n });
  }
}
