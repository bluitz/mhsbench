/**
 * Agent evals: run the real Claude agent through each scenario with no instrument delays, play the human at the
 * bench, and score what the agent did. This calls the model (about 120 Sonnet calls per pass), so it is not part of
 * `bun test`. Results are written to evals/results/<date>.md so prompt changes can be compared pass to pass.
 *
 * Usage: bun run eval              (2 repetitions per scenario)
 *        EVAL_REPS=1 bun run eval
 */
import { claudeAgent } from "../src/server/agents/claude";
import { groundTruth } from "../src/server/lab/bench";
import { runLoop } from "../src/server/loop";
import { Run } from "../src/server/runs";
import { fold } from "../src/shared/reducer";
import type { ExperimentProposal, FaultKind, FluidId, LabEvent } from "../src/shared/types";

type BenchAction = { fault: FaultKind } | { flowRateMax: number };

interface Scenario {
  name: string;
  fluid: FluidId;
  action: BenchAction | null; // what the human does after the third experiment
}

const SCENARIOS: Scenario[] = [
  { name: "water-clean", fluid: "water", action: null },
  { name: "bsa-clean", fluid: "bsa", action: null },
  { name: "tip", fluid: "water", action: { fault: "tip_pickup_failed" } },
  { name: "clog", fluid: "bsa", action: { fault: "clogged_tip" } },
  { name: "bubbles", fluid: "bsa", action: { fault: "bubbles" } },
  { name: "limit", fluid: "bsa", action: { flowRateMax: 100 } },
];

const REPS = Number(process.env.EVAL_REPS ?? 2);
const ACT_AFTER_EXPERIMENTS = 3;
const RUN_TIMEOUT_MS = 6 * 60_000;
const GUIDANCE = "The error is caused by bubbles in the liquid. Move to clean wells and reduce mixing cycles to 1 or 0.";
const noWait = { sleep: async () => {} };

interface Check {
  name: string;
  pass: boolean;
  note?: string;
}

interface Outcome {
  scenario: string;
  rep: number;
  experiments: number;
  bestRmse: number | null;
  floor: number;
  modelCalls: number;
  checks: Check[];
}

async function runScenario(scenario: Scenario, rep: number): Promise<Outcome> {
  const run = new Run(`eval-${scenario.name}-${rep}`, scenario.fluid, true);
  let completedExperiments = 0;
  let acted = false;
  let guided = false;
  let lastProposalId: string | null = null;

  // Play the human. Decisions are deferred a tick so the loop is already waiting for them.
  run.subscribers.add((event) => {
    const payload = event.payload as Record<string, any>;
    if (event.type === "hypothesis.proposed") lastProposalId = payload.experimentId;
    if (event.type === "experiment.completed") {
      completedExperiments += 1;
      if (completedExperiments === ACT_AFTER_EXPERIMENTS && scenario.action && !acted) {
        acted = true;
        if ("fault" in scenario.action) run.injectFault(scenario.action.fault);
        else run.setFlowRateLimit(scenario.action.flowRateMax);
      }
    }
    if (event.type === "loop.stage_changed" && payload.stage === "awaiting_human") {
      setTimeout(() => {
        if (scenario.name === "bubbles" && !guided) {
          guided = true;
          run.provideGuidance(GUIDANCE);
        } else if (lastProposalId) {
          run.decide(lastProposalId, { decision: "accept" });
        }
      }, 10);
    }
    if (event.type === "loop.stage_changed" && payload.stage === "agent_error") {
      setTimeout(() => run.abort("the agent kept failing"), 10);
    }
  });

  const timeout = setTimeout(() => run.abort("eval timed out"), RUN_TIMEOUT_MS);
  await runLoop(run, claudeAgent, noWait);
  clearTimeout(timeout);
  const outcome = score(scenario, rep, run.events);
  console.log(`${scenario.name} #${rep}: ${outcome.checks.every((c) => c.pass) ? "PASS" : "FAIL"} in ${outcome.experiments} experiments`);
  return outcome;
}

const proposalOf = (event: LabEvent) => event.payload.proposal as ExperimentProposal;

function score(scenario: Scenario, rep: number, events: LabEvent[]): Outcome {
  const state = fold(`eval`, scenario.fluid, true, events);
  const { floor } = groundTruth(scenario.fluid);
  const bestRmse = state.result?.bestRmse ?? null;
  const rejectionsFor = (text: string) => events.filter((e) => e.type === "hypothesis.rejected" && String(e.payload.reason).includes(text)).length;
  const recovered = events.find((e) => e.type === "fault.recovered");
  const attempts = recovered ? Number(recovered.payload.attempts) : null;
  const firstProposalAfter = (type: string) => {
    const at = events.findIndex((e) => e.type === type);
    return at < 0 ? undefined : events.slice(at).find((e) => e.type === "hypothesis.proposed");
  };

  const checks: Check[] = [
    { name: "completes", pass: state.stage === "complete", note: state.stage },
    { name: "finds the optimum", pass: bestRmse !== null && bestRmse <= floor * 1.1, note: bestRmse === null ? "no result" : `best ${bestRmse}, floor ${floor}` },
    { name: "no out-of-range proposals", pass: rejectionsFor("Outside") === 0, note: `${rejectionsFor("Outside")}` },
    { name: "no third replicates", pass: rejectionsFor("already been run twice") === 0, note: `${rejectionsFor("already been run twice")}` },
  ];

  if (scenario.name === "tip") {
    checks.push({ name: "tip recovered on attempt 1", pass: attempts === 1, note: `attempts ${attempts ?? "none"}` });
  }
  if (scenario.name === "clog") {
    const detectedAt = events.findIndex((e) => e.type === "fault.detected");
    const replace = detectedAt < 0 ? undefined : events.slice(detectedAt).find((e) => e.type === "hypothesis.proposed" && proposalOf(e).tip === "replace");
    const words = replace ? `${proposalOf(replace).rationale} ${proposalOf(replace).diagnosis ?? ""}` : "";
    checks.push({ name: "clog recovered by attempt 2", pass: attempts !== null && attempts <= 2, note: `attempts ${attempts ?? "none"}` });
    checks.push({ name: "clog reasoning names the cause", pass: /clog/i.test(words) && /flow/i.test(words), note: words.slice(0, 80) });
  }
  if (scenario.name === "bubbles") {
    const escalated = firstProposalAfter("fault.escalated");
    const afterGuidance = firstProposalAfter("guidance.provided");
    const p = afterGuidance ? proposalOf(afterGuidance) : undefined;
    checks.push({ name: "escalated proposal has a diagnosis", pass: Boolean(escalated && escalated.payload.escalation && proposalOf(escalated).diagnosis) });
    checks.push({ name: "follows guidance (mixing at most 1, clean wells)", pass: Boolean(p && p.mixing_cycles <= 1 && p.wells === "clean"), note: p ? `mixing ${p.mixing_cycles}, wells ${p.wells}` : "none" });
  }
  if (scenario.name === "limit") {
    const next = firstProposalAfter("driver.rejected");
    const p = next ? proposalOf(next) : undefined;
    checks.push({ name: "driver refused a high proposal", pass: next !== undefined });
    checks.push({ name: "next proposal within the new limit", pass: Boolean(p && p.flow_rate_uL_per_s <= 100), note: p ? `${p.flow_rate_uL_per_s} uL/s` : "none" });
  }

  const modelCalls = events.filter((e) => e.type === "hypothesis.proposed" || e.type === "agent.api_retry").length;
  return { scenario: scenario.name, rep, experiments: state.experiments.length, bestRmse, floor, modelCalls, checks };
}

function report(outcomes: Outcome[]): string {
  const lines: string[] = [];
  lines.push(`# Agent eval, ${new Date().toISOString()}`, "");
  lines.push(`Model: ${process.env.AGENT_MODEL ?? "claude-sonnet-5"}. ${REPS} repetition(s) per scenario. Model calls: ${outcomes.reduce((n, o) => n + o.modelCalls, 0)}.`, "");
  lines.push("| Scenario | Runs passing every check | Median experiments | Failed checks |", "|---|---|---|---|");
  for (const scenario of SCENARIOS) {
    const runs = outcomes.filter((o) => o.scenario === scenario.name);
    const passing = runs.filter((o) => o.checks.every((c) => c.pass)).length;
    const counts = runs.map((o) => o.experiments).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)] ?? 0;
    const failed = runs.flatMap((o) => o.checks.filter((c) => !c.pass).map((c) => `${c.name} (#${o.rep}${c.note ? `: ${c.note}` : ""})`));
    lines.push(`| ${scenario.name} | ${passing} of ${runs.length} | ${median} | ${failed.join("; ") || "none"} |`);
  }
  lines.push("", "## Every run", "", "| Scenario | Rep | Experiments | Best RMSE | Floor | Checks |", "|---|---|---|---|---|---|");
  for (const o of outcomes) {
    const checks = o.checks.map((c) => `${c.pass ? "pass" : "FAIL"} ${c.name}`).join(", ");
    lines.push(`| ${o.scenario} | ${o.rep} | ${o.experiments} | ${o.bestRmse ?? "none"} | ${o.floor} | ${checks} |`);
  }
  return lines.join("\n") + "\n";
}

const jobs: Promise<Outcome>[] = [];
for (const scenario of SCENARIOS) for (let rep = 1; rep <= REPS; rep++) jobs.push(runScenario(scenario, rep));
const outcomes = await Promise.all(jobs);
const text = report(outcomes);
const file = `evals/results/${new Date().toISOString().slice(0, 16).replace(":", "-")}.md`;
await Bun.write(file, text);
console.log("\n" + text);
console.log(`saved ${file}`);
