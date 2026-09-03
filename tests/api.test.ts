import { describe, expect, test } from "bun:test";
import { app } from "../src/server/index";

/** Routes that do not start a run, so no model is called. */
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("HTTP routes", () => {
  test("health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("rejects an unknown sample before creating a run", async () => {
    const res = await app.request("/api/runs", json({ protein_id: "mercury", auto_mode: true }));
    expect(res.status).toBe(400);
  });

  test("commands against a run that does not exist are 404", async () => {
    expect((await app.request("/api/runs/nope/events")).status).toBe(404);
    expect((await app.request("/api/runs/nope/decision", json({ experiment_id: "exp-1", decision: "accept" }))).status).toBe(404);
    expect((await app.request("/api/runs/nope/retry", json({}))).status).toBe(404);
  });

  test("validates a fault name and a limit value before touching the run", async () => {
    expect((await app.request("/api/runs/nope/faults", json({ fault: "gremlins" }))).status).toBe(400);
    expect((await app.request("/api/runs/nope/limits", json({ flow_rate_max: 900 }))).status).toBe(400);
  });
});
