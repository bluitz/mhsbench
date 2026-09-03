/**
 * The hypothesis agent. One Claude call per turn; the reply is a single JSON proposal.
 * Claude chooses the parameters; the loop operates the instruments.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ExperimentView, FluidCard, Proposal } from "../../shared/types";

export interface AgentContext {
  fluid: FluidCard;
  manifest: string;
  experiments: ExperimentView[];
  guidance: string[];
  fault: { attempts: number; maxAttempts: number; escalated: boolean } | null;
  driverErrors: string[];
  concludeRejection: string | null;
}

export interface Agent {
  propose(context: AgentContext): Promise<Proposal>;
}

const MODEL = process.env.AGENT_MODEL ?? "claude-sonnet-5";
// Reads ANTHROPIC_API_KEY from the environment. Identity-linked keys must also name the workspace they act in.
const client = new Anthropic({
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {},
});

export const claudeAgent: Agent = {
  async propose(context) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // The system prompt is the same on every call, so it is cached.
      system: [{ type: "text", text: systemPrompt(context.manifest), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt(context) }],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return parseProposal(text);
  },
};

function systemPrompt(manifest: string): string {
  return `You are an autonomous laboratory agent operating a liquid handler and a plate reader through Model Hardware Standard drivers.

Goal: find the flow rate that dispenses the current sample most accurately. Accuracy is the root mean square error (RMSE) of 8 replicate absorbance readings against the expected reading of 1.000. An experiment is a success when RMSE is at or below the sample's published assay tolerance.

Devices, from the driver manifests. The driver rejects any value outside the allowed ranges.
${manifest}

How each experiment runs. The run loop takes your proposal and executes, in order: eject the tip if you asked to replace it; pick up a tip if none is attached (at the next rack position if you asked to retry the pickup); move to clean wells if you asked; write the flow rate; write the mixing cycles; transfer 100 uL into the 8 current wells; mix if mixing cycles is above 0; read absorbance. You then receive the RMSE and the mean delivered fraction, or the driver error that stopped the experiment.

Strategy. First sweep at least six log-spaced flow rates spanning the whole allowed range, one per experiment. Then refine around the best result. You may conclude only when the optimum is proven: two successes at the best flow rate, plus one experiment between 10% and 60% slower and one between 10% and 60% faster that both scored worse. Do not repeat identical parameters more than twice. Keep the tip and reuse the current wells unless something went wrong with them.

Faults. Hardware fails. Read error codes carefully. A mean delivered fraction well below 1.0 that does not change with flow rate means the tip is under-delivering. If a human reviewer gives guidance, follow it for the rest of the run. When escalated, your proposal must include a diagnosis of why the previous attempts failed.

Respond with only a JSON object and no other text, in one of these two shapes:
{"kind":"experiment","flow_rate_uL_per_s":<number>,"mixing_cycles":<integer>,"tip":"keep"|"replace"|"retry_pickup_next_position","wells":"current"|"clean","rationale":"<one or two sentences>","diagnosis":"<only when escalated>"}
{"kind":"conclude","best_flow_rate_uL_per_s":<number>,"rationale":"<one sentence>"}`;
}

function userPrompt(c: AgentContext): string {
  const lines: string[] = [];
  lines.push(`Sample: ${c.fluid.name}. ${c.fluid.character}. ${c.fluid.description}`);
  lines.push(`Assay tolerance: RMSE <= ${c.fluid.tolerance}.`);
  lines.push("");
  if (c.experiments.length === 0) {
    lines.push("No experiments have been run yet on this sample.");
  } else {
    lines.push("Experiments so far (most recent last):");
    for (const x of c.experiments) lines.push(describeExperiment(x));
  }
  if (c.driverErrors.length) {
    lines.push("", "Recent driver errors:", ...c.driverErrors.map((e) => `- ${e}`));
  }
  if (c.fault) {
    lines.push("", `Fault recovery: attempt ${c.fault.attempts} of ${c.fault.maxAttempts} used.`);
    if (c.fault.escalated) lines.push("ESCALATED: a human reviewer must approve your next proposal. Include a diagnosis.");
  }
  if (c.guidance.length) {
    lines.push("", "Guidance from the human reviewer (follow it for the rest of the run):", ...c.guidance.map((g) => `- ${g}`));
  }
  if (c.concludeRejection) lines.push("", `Your previous conclusion was not accepted: ${c.concludeRejection}`);
  lines.push("", "Propose the next step as a JSON object.");
  return lines.join("\n");
}

function describeExperiment(x: ExperimentView): string {
  const p = x.proposal;
  const params = `flow ${p.flow_rate_uL_per_s} uL/s, mixing ${p.mixing_cycles}, tip ${p.tip}, wells ${p.wells}`;
  if (x.status === "rejected") return `#${x.index}: ${params} -> REJECTED by reviewer: ${x.decisionReason ?? ""}`;
  if (x.status === "error") return `#${x.index}: ${params} -> ERROR ${x.errorCode}: ${x.errorMessage}`;
  if (x.status === "success" || x.status === "failure") {
    return `#${x.index}: ${params} -> ${x.status.toUpperCase()} RMSE ${x.rmse}, mean delivered ${x.meanDelivered}`;
  }
  return `#${x.index}: ${params} -> ${x.status}`;
}

/** Turn Claude's reply into a typed proposal. Anything malformed is an error, which triggers a retry. */
export function parseProposal(text: string): Proposal {
  const json = text.replace(/```json|```/g, "").trim();
  const data = JSON.parse(json);
  if (data.kind === "conclude") {
    if (typeof data.best_flow_rate_uL_per_s !== "number") throw new Error("conclude proposal missing best_flow_rate_uL_per_s");
    return { kind: "conclude", best_flow_rate_uL_per_s: data.best_flow_rate_uL_per_s, rationale: String(data.rationale ?? "") };
  }
  if (data.kind === "experiment") {
    if (typeof data.flow_rate_uL_per_s !== "number") throw new Error("experiment proposal missing flow_rate_uL_per_s");
    const tip = ["keep", "replace", "retry_pickup_next_position"].includes(data.tip) ? data.tip : "keep";
    const wells = data.wells === "clean" ? "clean" : "current";
    return {
      kind: "experiment",
      flow_rate_uL_per_s: Math.round(data.flow_rate_uL_per_s * 10) / 10,
      mixing_cycles: Number.isInteger(data.mixing_cycles) ? data.mixing_cycles : 3,
      tip,
      wells,
      rationale: String(data.rationale ?? ""),
      diagnosis: data.diagnosis ? String(data.diagnosis) : undefined,
    };
  }
  throw new Error(`Unknown proposal kind: ${data.kind}`);
}
