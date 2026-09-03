import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createClaudeAgent, systemPrompt, userPrompt, type AgentContext } from "../src/server/agents/claude";
import { manifestText } from "../src/server/lab/bench";
import { FLUID_CARDS } from "../src/shared/fluids";
import type { ExperimentView, FluidId } from "../src/shared/types";

function context(fluid: FluidId, overrides: Partial<AgentContext> = {}): AgentContext {
  return { fluid: FLUID_CARDS[fluid], manifest: manifestText(), experiments: [], guidance: [], fault: null, driverErrors: [], ...overrides };
}

function experiment(index: number, status: ExperimentView["status"], extra: Partial<ExperimentView> = {}): ExperimentView {
  return {
    id: `exp-${index}`,
    index,
    proposal: { kind: "experiment", flow_rate_uL_per_s: 45, mixing_cycles: 2, tip: "keep", wells: "clean", rationale: "" },
    status,
    escalation: false,
    ...extra,
  };
}

describe("no answer leakage", () => {
  // The agent may only learn the optimum from its own experiments. The prompts must never carry the hidden physics.
  test("water: neither the ideal flow rate nor the RMSE floor appears before any experiment has run", () => {
    const text = systemPrompt(manifestText()) + "\n" + userPrompt(context("water"));
    expect(text).not.toContain("140 uL/s");
    expect(text).not.toContain("0.016");
    expect(text).not.toMatch(/ideal|floor/i);
    expect(text).toContain("0.0176"); // the published tolerance is allowed
  });

  test("BSA: neither 10 uL/s nor 0.181 appears before any experiment has run", () => {
    const text = systemPrompt(manifestText()) + "\n" + userPrompt(context("bsa"));
    expect(text).not.toContain("10 uL/s");
    expect(text).not.toContain("0.181");
    expect(text).not.toMatch(/ideal|floor/i);
    expect(text).toContain("0.1991");
  });
});

describe("prompt rendering", () => {
  test("the system prompt carries the device manifests and the JSON shape the parser expects", () => {
    const text = systemPrompt(manifestText());
    expect(text).toContain("flow_rate_uL_per_s (allowed 5 to 250)");
    expect(text).toContain("read_absorbance");
    expect(text).toContain('"kind":"experiment"');
    expect(text).toContain("Change one variable at a time");
  });

  test("each experiment is described by what happened to it", () => {
    const text = userPrompt(
      context("bsa", {
        experiments: [
          experiment(1, "success", { rmse: 0.18, meanDelivered: 1 }),
          experiment(2, "failure", { rmse: 0.5, meanDelivered: 0.55 }),
          experiment(3, "error", { errorCode: "E-217", errorMessage: "FLUID_DETECTION_ERROR" }),
          experiment(4, "rejected", { decisionReason: "already run twice" }),
        ],
      }),
    );
    expect(text).toContain("#1: flow 45 uL/s, mixing 2, tip keep, wells clean -> SUCCESS RMSE 0.18, mean delivered 1");
    expect(text).toContain("#2: flow 45 uL/s, mixing 2, tip keep, wells clean -> FAILURE RMSE 0.5, mean delivered 0.55");
    expect(text).toContain("#3: flow 45 uL/s, mixing 2, tip keep, wells clean -> ERROR E-217: FLUID_DETECTION_ERROR");
    expect(text).toContain("#4: flow 45 uL/s, mixing 2, tip keep, wells clean -> REJECTED by reviewer: already run twice");
  });

  test("guidance, driver errors, and escalation reach the agent", () => {
    const text = userPrompt(
      context("bsa", {
        guidance: ["Replace the tip before the next transfer."],
        driverErrors: ["write flow_rate_uL_per_s: DRIVER_REJECTED outside the allowed range 5 to 100"],
        fault: { attempts: 3, maxAttempts: 3, escalated: true },
      }),
    );
    expect(text).toContain("Guidance from the human reviewer");
    expect(text).toContain("- Replace the tip before the next transfer.");
    expect(text).toContain("Recent driver errors:");
    expect(text).toContain("outside the allowed range 5 to 100");
    expect(text).toContain("Fault recovery: attempt 3 of 3 used.");
    expect(text).toContain("ESCALATED: a human reviewer must approve your next proposal. Include a diagnosis.");
  });

  test("a run with no experiments says so instead of listing nothing", () => {
    expect(userPrompt(context("water"))).toContain("No experiments have been run yet");
  });
});

describe("the request Claude receives", () => {
  const reply = (text: string) => ({ content: [{ type: "text", text }] }) as unknown as Anthropic.Message;

  test("uses the configured model, adaptive thinking, medium effort, and a cached system prompt", async () => {
    let captured: Anthropic.MessageCreateParamsNonStreaming | null = null;
    const agent = createClaudeAgent(async (params) => {
      captured = params;
      return reply('{"kind":"experiment","flow_rate_uL_per_s":20,"mixing_cycles":1,"tip":"keep","wells":"current","rationale":"ok"}');
    });
    const proposal = await agent.propose(context("bsa"));
    expect(proposal.flow_rate_uL_per_s).toBe(20);
    const params = captured!;
    expect(params.model).toBe(process.env.AGENT_MODEL ?? "claude-sonnet-5");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "medium" });
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).toContain("Model Hardware Standard");
    expect(params.messages[0]!.content).toContain("BSA protein solution");
  });

  test("a reply with no text is an error, so the loop retries", async () => {
    const agent = createClaudeAgent(async () => ({ content: [] }) as unknown as Anthropic.Message);
    await expect(agent.propose(context("water"))).rejects.toThrow("no text");
  });

  test("a reply wrapped in a code fence still parses", async () => {
    const agent = createClaudeAgent(async () => reply('```json\n{"kind":"experiment","flow_rate_uL_per_s":50,"mixing_cycles":0,"tip":"replace","wells":"clean","rationale":"r"}\n```'));
    expect((await agent.propose(context("water"))).tip).toBe("replace");
  });
});
