import { describe, expect, test } from "bun:test";
import type { ExperimentProposal, LabEvent } from "../src/shared/types";

/** The recorded demos are real transcripts. These tests make sure each one still tells the story it was recorded for. */
interface Fixture {
  title: string;
  events: LabEvent[];
}

async function load(name: string): Promise<Fixture> {
  return JSON.parse(await Bun.file(`public/demos/${name}.json`).text());
}

const proposals = (events: LabEvent[]) => events.filter((e) => e.type === "hypothesis.proposed");
const proposalOf = (e: LabEvent) => e.payload.proposal as ExperimentProposal;
const indexOf = (events: LabEvent[], type: string, from = 0) => events.findIndex((e, i) => i >= from && e.type === type);

describe("recorded demos", () => {
  test("every demo completes with two successes in a row", async () => {
    for (const name of ["tip", "clog", "bubbles", "limit"]) {
      const { events } = await load(name);
      expect(events.at(-2)?.type).toBe("run.completed");
      expect((events.at(-2)!.payload.confirmedBy as string[]).length).toBe(2);
    }
  });

  test("tip: after the E-101 error the agent retries the pickup at the next rack position", async () => {
    const { events } = await load("tip");
    const error = indexOf(events, "driver.error");
    expect(events[error]!.payload.code).toBe("E-101");
    const next = proposals(events.slice(error))[0]!;
    expect(proposalOf(next).tip).toBe("retry_pickup_next_position");
    expect(proposalOf(next).rationale).toMatch(/next rack position|next position/i);
    expect(events.find((e) => e.type === "fault.recovered")?.payload.attempts).toBe(1);
  });

  test("clog: the agent sees delivery unchanged across flow rates and replaces the tip", async () => {
    const { events } = await load("clog");
    const detected = indexOf(events, "fault.detected");
    expect(events[detected]!.payload.signature).toBe("under_delivery");
    const recovery = proposals(events.slice(detected)).find((e) => proposalOf(e).tip === "replace")!;
    expect(recovery).toBeDefined();
    expect(proposalOf(recovery).rationale + " " + (proposalOf(recovery).diagnosis ?? "")).toMatch(/clog/i);
    expect(events.find((e) => e.type === "fault.recovered")?.payload.attempts).toBeLessThanOrEqual(2);
  });

  test("bubbles: three failed attempts, escalation with a diagnosis, then recovery only after guidance", async () => {
    const { events } = await load("bubbles");
    const escalated = indexOf(events, "fault.escalated");
    expect(escalated).toBeGreaterThan(0);
    expect(events[escalated]!.payload.n).toBe(3);
    const escalatedProposal = proposals(events.slice(escalated))[0]!;
    expect(escalatedProposal.payload.escalation).toBe(true);
    expect(proposalOf(escalatedProposal).diagnosis).toBeTruthy();
    const guidance = indexOf(events, "guidance.provided");
    const afterGuidance = proposals(events.slice(guidance))[0]!;
    expect(proposalOf(afterGuidance).mixing_cycles).toBeLessThanOrEqual(1);
    expect(proposalOf(afterGuidance).wells).toBe("clean");
    expect(indexOf(events, "fault.recovered")).toBeGreaterThan(guidance);
  });

  test("limit: the driver refuses the high proposal and the next one is within the new limit", async () => {
    const { events } = await load("limit");
    const changed = indexOf(events, "limit.changed");
    const refused = indexOf(events, "driver.rejected", changed);
    expect(refused).toBeGreaterThan(changed);
    expect(events[refused]!.payload.message).toContain("5 to 100");
    const next = proposals(events.slice(refused))[0]!;
    expect(proposalOf(next).flow_rate_uL_per_s).toBeLessThanOrEqual(100);
    expect(events.some((e) => e.type === "fault.detected")).toBe(false); // a refusal is not a bench fault
  });
});
