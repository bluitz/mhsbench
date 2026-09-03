/**
 * HTTP server. Commands come in over REST; the truth goes out over Server-Sent Events.
 * Every mutation returns {ok, seq} or an error status; the browser renders only from the event stream.
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { FLUID_CARDS } from "../shared/fluids";
import type { FaultKind, FluidId, LabEvent } from "../shared/types";
import { claudeAgent } from "./agents/claude";
import { runLoop } from "./loop";
import { RunManager, type CommandResult } from "./runs";

const HEARTBEAT_MS = 10_000; // keeps the proxy from closing an idle stream while a human thinks
const POLL_MS = 100;

export const app = new Hono(); // exported so tests can call routes without starting a server
const runs = new RunManager();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/api/runs", async (c) => {
  const body = await c.req.json();
  const fluidId = body.protein_id as FluidId;
  if (!FLUID_CARDS[fluidId]) return c.json({ ok: false, error: "Unknown sample" }, 400);
  const run = runs.create(fluidId, Boolean(body.auto_mode));
  runLoop(run, claudeAgent).catch((err) => run.abort(`Internal error: ${err instanceof Error ? err.message : String(err)}`));
  return c.json({ ok: true, run_id: run.id });
});

app.get("/api/runs/:id/events", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ ok: false, error: "No such run" }, 404);
  const after = Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0);
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    // Subscribe before reading the catch-up slice so nothing appended in between is lost.
    const incoming: LabEvent[] = [];
    const subscriber = (e: LabEvent) => incoming.push(e);
    run.subscribers.add(subscriber);
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      run.subscribers.delete(subscriber);
    });

    let lastSent = after;
    const send = async (e: LabEvent) => {
      if (e.seq <= lastSent) return; // already delivered (catch-up and live can overlap)
      lastSent = e.seq;
      await stream.writeSSE({ id: String(e.seq), event: "lab", data: JSON.stringify(e) });
    };

    for (const e of run.events.filter((e) => e.seq > after)) await send(e);

    let sinceHeartbeat = 0;
    while (!closed) {
      while (incoming.length) await send(incoming.shift()!);
      if (run.ended) break; // the run is over and every event has been sent, so end the stream
      await stream.sleep(POLL_MS);
      sinceHeartbeat += POLL_MS;
      if (sinceHeartbeat >= HEARTBEAT_MS) {
        await stream.write(": heartbeat\n\n");
        sinceHeartbeat = 0;
      }
    }
    run.subscribers.delete(subscriber);
  });
});

/** Shared shape for every command endpoint: look up the run, apply the command, map the result to a status. */
function command(c: any, apply: (run: NonNullable<ReturnType<RunManager["get"]>>) => CommandResult) {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ ok: false, error: "No such run" }, 404);
  const result = apply(run);
  return c.json(result, result.ok ? 200 : result.status);
}

app.post("/api/runs/:id/decision", async (c) => {
  const body = await c.req.json();
  return command(c, (run) => run.decide(String(body.experiment_id), { decision: body.decision, edits: body.edits, reason: body.reason }));
});

app.post("/api/runs/:id/guidance", async (c) => {
  const body = await c.req.json();
  return command(c, (run) => run.provideGuidance(String(body.text)));
});

app.post("/api/runs/:id/faults", async (c) => {
  const body = await c.req.json();
  const fault = body.fault as FaultKind;
  if (!["tip_pickup_failed", "clogged_tip", "bubbles"].includes(fault)) return c.json({ ok: false, error: "Unknown fault" }, 400);
  return command(c, (run) => run.injectFault(fault));
});

app.post("/api/runs/:id/limits", async (c) => {
  const body = await c.req.json();
  const max = Number(body.flow_rate_max);
  if (!(max > 5 && max <= 250)) return c.json({ ok: false, error: "flow_rate_max must be between 5 and 250" }, 400);
  return command(c, (run) => run.setFlowRateLimit(max));
});

app.post("/api/runs/:id/mode", async (c) => {
  const body = await c.req.json();
  return command(c, (run) => run.setAutoMode(Boolean(body.auto_mode)));
});

app.post("/api/runs/:id/retry", (c) => command(c, (run) => run.retry()));

app.post("/api/runs/:id/abort", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return command(c, (run) => run.abort(String(body.reason ?? "Aborted by reviewer")));
});

app.use("/results/*", serveStatic({ root: "./" })); // the saved result files, so a reviewer can open them
app.use("/*", serveStatic({ root: "./public" }));

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
  idleTimeout: 60, // seconds; must exceed the SSE heartbeat interval
};
