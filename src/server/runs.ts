/**
 * A Run is one optimization session: its event log, its simulated bench, and the things the loop waits on
 * (a human decision, a retry after an agent failure). The RunManager holds every live run in memory.
 */
import type { Actor, ExperimentProposal, FaultKind, FluidId, LabEvent } from "../shared/types";
import { Driver, Simulator, type BenchControl, type CommandRecord } from "./lab/bench";

export interface Decision {
  decision: "accept" | "reject" | "superseded"; // superseded: a new guidance message replaced the pending hypothesis
  edits?: Partial<ExperimentProposal>;
  reason?: string;
}

export type CommandResult = { ok: true; seq: number } | { ok: false; status: 404 | 409; error: string };

export class Run {
  readonly events: LabEvent[] = [];
  readonly subscribers = new Set<(e: LabEvent) => void>();
  readonly driver: Driver;
  readonly control: BenchControl; // the human at the bench; never handed to the loop's agent
  autoMode: boolean;
  aborted = false;
  ended = false;
  faultInjected = false;

  private pendingDecision: { experimentId: string; resolve: (d: Decision) => void } | null = null;
  private decisions = new Map<string, { body: Decision; seq: number }>(); // makes the decision endpoint idempotent
  private retryWaiter: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly fluidId: FluidId,
    autoMode: boolean,
  ) {
    this.autoMode = autoMode;
    const simulator = new Simulator(fluidId);
    this.control = simulator;
    this.driver = new Driver(simulator, (record) => this.logCommand(record));
  }

  /** Append an event and push it to every open SSE connection. The log is the only source of truth. */
  emit(actor: Actor, type: string, payload: Record<string, unknown>, experimentId?: string): LabEvent {
    const event: LabEvent = {
      seq: this.events.length + 1,
      ts: new Date().toISOString(),
      runId: this.id,
      actor,
      type,
      experimentId,
      payload,
    };
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  private logCommand({ device, action, params, result }: CommandRecord) {
    this.emit("driver", "driver.command", { device, action, params });
    if (result.ok) {
      this.emit(device, "driver.result", { device, action, data: result.data ?? null, state: result.state });
    } else if (result.code === "DRIVER_REJECTED") {
      this.emit("driver", "driver.rejected", { device, action, message: result.message, state: result.state });
    } else {
      this.emit(device, "driver.error", { device, action, code: result.code, message: result.message, state: result.state });
    }
  }

  // ---- Things the loop waits on ----

  waitForDecision(experimentId: string): Promise<Decision> {
    return new Promise((resolve) => {
      this.pendingDecision = { experimentId, resolve };
    });
  }

  waitForRetry(): Promise<void> {
    return new Promise((resolve) => {
      this.retryWaiter = resolve;
    });
  }

  // ---- Commands from the reviewer (HTTP) ----

  decide(experimentId: string, body: Decision): CommandResult {
    const previous = this.decisions.get(experimentId);
    if (previous) {
      const sameDecision = JSON.stringify(previous.body) === JSON.stringify(body);
      if (sameDecision) return { ok: true, seq: previous.seq }; // double click or browser retry: harmless
      return { ok: false, status: 409, error: "A different decision was already recorded for this hypothesis." };
    }
    if (!this.pendingDecision || this.pendingDecision.experimentId !== experimentId) {
      return { ok: false, status: 409, error: "That hypothesis is no longer waiting for a decision." };
    }
    const event =
      body.decision === "accept"
        ? this.emit("reviewer", "hypothesis.accepted", { by: "reviewer", edits: body.edits ?? null, reason: body.reason ?? null }, experimentId)
        : this.emit("reviewer", "hypothesis.rejected", { by: "reviewer", reason: body.reason ?? "No reason given" }, experimentId);
    this.decisions.set(experimentId, { body, seq: event.seq });
    this.resolvePending(body);
    return { ok: true, seq: event.seq };
  }

  provideGuidance(text: string): CommandResult {
    const event = this.emit("reviewer", "guidance.provided", { text });
    // Guidance replaces whatever hypothesis is waiting, so the agent can re-plan with it.
    if (this.pendingDecision) {
      const { experimentId } = this.pendingDecision;
      this.emit("reviewer", "hypothesis.rejected", { by: "reviewer", reason: "Superseded by reviewer guidance" }, experimentId);
      this.decisions.set(experimentId, { body: { decision: "superseded" }, seq: event.seq });
      this.resolvePending({ decision: "superseded" });
    }
    return { ok: true, seq: event.seq };
  }

  injectFault(fault: FaultKind): CommandResult {
    if (this.control.activeFault()) {
      return { ok: false, status: 409, error: "A fault is already active. Wait until it is recovered." };
    }
    this.control.inject(fault);
    this.faultInjected = true;
    const event = this.emit("reviewer", "fault.injected", { fault });
    return { ok: true, seq: event.seq };
  }

  /** The operator tightens a safety limit on the bench. The driver enforces it from the next write on. */
  setFlowRateLimit(max: number): CommandResult {
    this.driver.setLimit("flow_rate_uL_per_s", max);
    const event = this.emit("reviewer", "limit.changed", { tag: "flow_rate_uL_per_s", max });
    return { ok: true, seq: event.seq };
  }

  setAutoMode(autoMode: boolean): CommandResult {
    this.autoMode = autoMode;
    const event = this.emit("reviewer", "run.mode_changed", { autoMode });
    return { ok: true, seq: event.seq };
  }

  retry(): CommandResult {
    if (!this.retryWaiter) return { ok: false, status: 409, error: "The run is not waiting for a retry." };
    const event = this.emit("reviewer", "agent.retry_requested", { by: "reviewer" });
    const wake = this.retryWaiter;
    this.retryWaiter = null;
    wake();
    return { ok: true, seq: event.seq };
  }

  abort(reason: string): CommandResult {
    if (this.ended) return { ok: true, seq: this.events.length };
    this.aborted = true;
    this.ended = true;
    const event = this.emit("reviewer", "run.aborted", { reason });
    this.emit("run_loop", "loop.stage_changed", { stage: "aborted" });
    this.resolvePending({ decision: "reject", reason: "Run aborted" });
    if (this.retryWaiter) this.retry();
    return { ok: true, seq: event.seq };
  }

  private resolvePending(decision: Decision) {
    const pending = this.pendingDecision;
    this.pendingDecision = null;
    pending?.resolve(decision);
  }
}

export class RunManager {
  private runs = new Map<string, Run>();

  create(fluidId: FluidId, autoMode: boolean): Run {
    const id = crypto.randomUUID().slice(0, 8);
    const run = new Run(id, fluidId, autoMode);
    this.runs.set(id, run);
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }
}
