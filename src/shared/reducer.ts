import type {
  DeviceState,
  ExperimentProposal,
  ExperimentView,
  FaultKind,
  FluidId,
  LabEvent,
  RunState,
  Stage,
} from "./types";
import { MAX_FAULT_ATTEMPTS } from "./types";

const EMPTY_DEVICES: DeviceState = {
  liquid_handler: {
    tip_attached: false,
    tip_position: 1,
    current_wells: "Plate 1, A1-A8",
    flow_rate_uL_per_s: 50,
    mixing_cycles: 3,
    last_dispensed_volume_uL: null,
    status: "no tip",
  },
  plate_reader: { wavelength_nm: 562, last_readings: null, status: "idle" },
};

export function initialState(runId: string, fluidId: FluidId, autoMode: boolean): RunState {
  return {
    runId,
    fluidId,
    autoMode,
    stage: "reviewing_history",
    experiments: [],
    pendingExperimentId: null,
    fault: null,
    retry: null,
    agentError: null,
    guidance: [],
    devices: EMPTY_DEVICES,
    result: null,
    abortReason: null,
  };
}

/** Pure fold: the same function reconstructs state for live streaming and for replay. */
export function reduce(state: RunState, e: LabEvent): RunState {
  const p = e.payload as Record<string, any>;
  const exp = (id?: string) => state.experiments.find((x) => x.id === id);
  const updateExp = (id: string, patch: Partial<ExperimentView>): RunState => ({
    ...state,
    experiments: state.experiments.map((x) => (x.id === id ? { ...x, ...patch } : x)),
  });

  switch (e.type) {
    case "run.created":
      return { ...state, fluidId: p.fluidId, autoMode: p.autoMode };
    case "run.mode_changed":
      return { ...state, autoMode: p.autoMode };
    case "loop.stage_changed":
      return { ...state, stage: p.stage as Stage, retry: p.stage === "proposing" ? null : state.retry };
    case "hypothesis.proposed": {
      const proposal = p.proposal as ExperimentProposal;
      const view: ExperimentView = {
        id: p.experimentId,
        index: state.experiments.length + 1,
        proposal,
        status: "proposed",
        escalation: Boolean(p.escalation),
      };
      return { ...state, experiments: [...state.experiments, view], pendingExperimentId: p.experimentId };
    }
    case "hypothesis.accepted": {
      const x = exp(e.experimentId);
      if (!x) return state;
      const merged = { ...x.proposal, ...(p.edits ?? {}) };
      return {
        ...updateExp(x.id, { proposal: merged, decidedBy: p.by, edits: p.edits, decisionReason: p.reason }),
        pendingExperimentId: null,
      };
    }
    case "hypothesis.rejected": {
      const x = exp(e.experimentId);
      if (!x) return state;
      return {
        ...updateExp(x.id, { status: "rejected", decidedBy: p.by, decisionReason: p.reason }),
        pendingExperimentId: null,
      };
    }
    case "experiment.started": {
      const x = exp(e.experimentId);
      return x ? updateExp(x.id, { status: "running" }) : state;
    }
    case "experiment.completed": {
      const x = exp(e.experimentId);
      if (!x) return state;
      return updateExp(x.id, {
        status: p.status,
        rmse: p.rmse,
        meanDelivered: p.meanDelivered,
        readings: p.readings,
        errorCode: p.errorCode,
        errorMessage: p.errorMessage,
      });
    }
    case "driver.result":
    case "driver.error":
      return p.state ? { ...state, devices: p.state as DeviceState } : state;
    case "fault.injected":
      return { ...state, fault: { kind: p.fault as FaultKind, active: true, detected: false, attempts: 0, escalated: false } };
    case "fault.detected":
      return state.fault ? { ...state, fault: { ...state.fault, detected: true } } : state;
    case "fault.attempt":
      return state.fault ? { ...state, fault: { ...state.fault, attempts: p.n } } : state;
    case "fault.escalated":
      return state.fault ? { ...state, fault: { ...state.fault, escalated: true, attempts: p.n } } : state;
    case "fault.recovered":
      return state.fault ? { ...state, fault: { ...state.fault, active: false } } : state;
    case "guidance.provided":
      return { ...state, guidance: [...state.guidance, p.text] };
    case "agent.api_retry":
      return { ...state, retry: { attempt: p.attempt, maxAttempts: p.maxAttempts, delayMs: p.delayMs, error: p.error } };
    case "agent.failed":
      return { ...state, retry: null, agentError: { error: p.error, attempts: p.attempts } };
    case "agent.retry_requested":
      return { ...state, agentError: null };
    case "run.completed":
      return {
        ...state,
        result: {
          bestFlowRate: p.bestFlowRate,
          bestRmse: p.bestRmse,
          experiments: p.experiments,
          confirmedBy: p.confirmedBy ?? [],
          resultFile: p.resultFile ?? "",
          resultJson: p.resultJson ?? "",
        },
      };
    case "run.aborted":
      return { ...state, abortReason: p.reason, pendingExperimentId: null };
    default:
      return state;
  }
}

export function fold(runId: string, fluidId: FluidId, autoMode: boolean, events: LabEvent[]): RunState {
  return events.reduce(reduce, initialState(runId, fluidId, autoMode));
}

export function faultAttemptText(state: RunState): string | null {
  if (!state.fault || !state.fault.active || !state.fault.detected) return null;
  if (state.fault.escalated) {
    return `Fault recovery attempt ${state.fault.attempts} of ${MAX_FAULT_ATTEMPTS} used. A human reviewer must approve every step until the fault is cleared.`;
  }
  return `Fault recovery attempt ${state.fault.attempts} of ${MAX_FAULT_ATTEMPTS}. After ${MAX_FAULT_ATTEMPTS} failed attempts a human reviewer must approve the next step.`;
}
