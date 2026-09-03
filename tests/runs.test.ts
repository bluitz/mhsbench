import { describe, expect, test } from "bun:test";
import { Run } from "../src/server/runs";

describe("Run", () => {
  test("numbers events in order and pushes them to subscribers", () => {
    const run = new Run("r1", "water", true);
    const seen: number[] = [];
    run.subscribers.add((e) => seen.push(e.seq));
    run.emit("run_loop", "a", {});
    run.emit("run_loop", "b", {});
    expect(run.events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(seen).toEqual([1, 2]);
  });

  test("a decision is accepted only for the hypothesis that is waiting, and repeats are harmless", async () => {
    const run = new Run("r1", "water", false);
    expect(run.decide("exp-1", { decision: "accept" })).toMatchObject({ ok: false, status: 409 });

    const waiting = run.waitForDecision("exp-1");
    expect(run.decide("exp-2", { decision: "accept" })).toMatchObject({ ok: false, status: 409 }); // stale click
    const first = run.decide("exp-1", { decision: "accept", edits: { flow_rate_uL_per_s: 60 } });
    expect(first.ok).toBe(true);
    expect(await waiting).toEqual({ decision: "accept", edits: { flow_rate_uL_per_s: 60 } });

    const again = run.decide("exp-1", { decision: "accept", edits: { flow_rate_uL_per_s: 60 } });
    expect(again).toEqual(first); // same body, same seq, nothing re-executed
    expect(run.decide("exp-1", { decision: "reject" })).toMatchObject({ ok: false, status: 409 });
    expect(run.events.filter((e) => e.type === "hypothesis.accepted")).toHaveLength(1);
  });

  test("guidance replaces the pending hypothesis so the agent can re-plan", async () => {
    const run = new Run("r1", "bsa", true);
    const waiting = run.waitForDecision("exp-3");
    run.provideGuidance("Replace the tip.");
    expect(await waiting).toEqual({ decision: "superseded" });
    expect(run.events.map((e) => e.type)).toEqual(["guidance.provided", "hypothesis.rejected"]);
    expect(run.events[1]!.payload.reason).toBe("Superseded by reviewer guidance");
  });

  test("only one fault can be active at a time", () => {
    const run = new Run("r1", "bsa", true);
    expect(run.injectFault("clogged_tip").ok).toBe(true);
    expect(run.injectFault("bubbles")).toMatchObject({ ok: false, status: 409 });
    expect(run.faultInjected).toBe(true);
  });

  test("retry only works while the run is waiting for one", async () => {
    const run = new Run("r1", "water", true);
    expect(run.retry()).toMatchObject({ ok: false, status: 409 });
    const waiting = run.waitForRetry();
    expect(run.retry().ok).toBe(true);
    await waiting;
    expect(run.events.at(-1)!.type).toBe("agent.retry_requested");
  });

  test("abort ends the run once, releases a pending decision, and is a no-op afterwards", async () => {
    const run = new Run("r1", "water", false);
    const waiting = run.waitForDecision("exp-1");
    run.abort("because");
    expect(await waiting).toMatchObject({ decision: "reject" });
    expect(run.aborted).toBe(true);
    expect(run.events.map((e) => e.type)).toEqual(["run.aborted", "loop.stage_changed"]);
    run.abort("again");
    expect(run.events).toHaveLength(2);
  });

  test("an operator can lower the flow-rate limit and the driver then refuses higher writes", () => {
    const run = new Run("r1", "bsa", true);
    expect(run.driver.write("liquid_handler", "flow_rate_uL_per_s", 200).ok).toBe(true);
    run.setFlowRateLimit(100);
    expect(run.events.at(-1)!.type).toBe("limit.changed");
    const refused = run.driver.write("liquid_handler", "flow_rate_uL_per_s", 135);
    expect(refused.code).toBe("DRIVER_REJECTED");
    expect(refused.message).toContain("5 to 100");
    expect(refused.message).toContain("operator");
    expect(run.driver.write("liquid_handler", "flow_rate_uL_per_s", 90).ok).toBe(true);
    expect(run.events.filter((e) => e.type === "driver.rejected")).toHaveLength(1);
  });
});
