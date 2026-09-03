/**
 * Record a demo: run one fault scenario against a running server, in auto mode, and save its whole
 * event log as a fixture the browser can replay with no server and no model.
 *
 * Usage: bun scripts/record-demo.ts tip|clog|bubbles [http://localhost:3111]
 */
import type { FaultKind, FluidId, LabEvent } from "../src/shared/types";

const DEMOS: Record<string, { fluid: FluidId; fault: FaultKind; title: string; description: string }> = {
  tip: {
    fluid: "water",
    fault: "tip_pickup_failed",
    title: "Failed tip pickup",
    description: "The liquid handler fails to seat a tip. Watch the agent read the error and reason that retrying at the next rack position will fix it.",
  },
  clog: {
    fluid: "bsa",
    fault: "clogged_tip",
    title: "Clogged tip",
    description: "The tip silently delivers half the volume. Watch the agent notice that the delivered amount stays the same even as the flow rate changes, and replace the tip.",
  },
  bubbles: {
    fluid: "bsa",
    fault: "bubbles",
    title: "Bubbles in the wells",
    description: "Every transfer fails with a fluid detection error. The agent cannot fix it alone: after three attempts it escalates, a human explains the physics, and it recovers.",
  },
};

const INJECT_AFTER_EXPERIMENTS = 3; // let the sweep get going before breaking something
const GUIDANCE = "The error is caused by bubbles in the liquid. Move to clean wells and reduce mixing cycles to 1 or 0.";

const name = process.argv[2] ?? "";
const base = process.argv[3] ?? "http://localhost:3111";
const demo = DEMOS[name];
if (!demo) {
  console.error("usage: bun scripts/record-demo.ts tip|clog|bubbles [base url]");
  process.exit(1);
}

async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

const { run_id } = await post("/api/runs", { protein_id: demo.fluid, auto_mode: true });
console.log(`recording ${name} as run ${run_id}`);

const events: LabEvent[] = [];
let completedExperiments = 0;
let injected = false;
let guided = false;
let lastProposalId: string | null = null;

// Read the Server-Sent Events stream line by line. The server ends it when the run finishes.
const response = await fetch(`${base}/api/runs/${run_id}/events`);
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5)) as LabEvent;
    events.push(event);
    const payload = event.payload as Record<string, any>;

    if (event.type === "hypothesis.proposed") lastProposalId = payload.experimentId;

    if (event.type === "experiment.completed") {
      completedExperiments += 1;
      if (completedExperiments === INJECT_AFTER_EXPERIMENTS && !injected) {
        injected = true;
        console.log(`injecting ${demo.fault} after experiment ${completedExperiments}`);
        await post(`/api/runs/${run_id}/faults`, { fault: demo.fault });
      }
    }

    // Play the human: explain bubbles once, otherwise approve whatever the escalated agent proposes.
    if (event.type === "loop.stage_changed" && payload.stage === "awaiting_human") {
      if (name === "bubbles" && !guided) {
        guided = true;
        console.log("sending guidance");
        await post(`/api/runs/${run_id}/guidance`, { text: GUIDANCE });
      } else {
        console.log(`accepting ${lastProposalId}`);
        await post(`/api/runs/${run_id}/decision`, { experiment_id: lastProposalId, decision: "accept" });
      }
    }
  }
}

const file = `public/demos/${name}.json`;
await Bun.write(file, JSON.stringify({ name, title: demo.title, description: demo.description, fluidId: demo.fluid, events }, null, 2));
console.log(`saved ${file} with ${events.length} events`);
