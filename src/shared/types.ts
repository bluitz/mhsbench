// Shared between server and client. Keep this file free of server-only imports.

export type FluidId = "water" | "bsa";

export interface FluidCard {
  id: FluidId;
  name: string;
  character: string;
  description: string;
  /** Published assay tolerance: an experiment passes when RMSE <= tolerance. */
  tolerance: number;
}

export type FaultKind = "tip_pickup_failed" | "clogged_tip" | "bubbles";

export const FAULT_DESCRIPTIONS: Record<FaultKind, { title: string; description: string }> = {
  tip_pickup_failed: {
    title: "Failed tip pickup",
    description: "The liquid handler reports an error on the next tip pickup and no liquid moves.",
  },
  clogged_tip: {
    title: "Clogged tip",
    description: "The tip delivers about half the volume from now on, no matter what flow rate is used.",
  },
  bubbles: {
    title: "Bubbles in the wells",
    description: "Every transfer into the current wells fails with a fluid detection error until a human guides the agent.",
  },
};

/** Preset guidance a reviewer can send. The label is the few-word form shown on the timeline. */
export const GUIDANCE_PRESETS = [
  { label: "bubbles, use clean wells and gentle mixing", text: "The error is caused by bubbles in the liquid. Move to clean wells and reduce mixing cycles to 1 or 0." },
  { label: "replace the tip", text: "Replace the tip before the next transfer." },
  { label: "slow down", text: "Slow down: try a lower flow rate." },
];

/** A flag shown above an experiment card: a fault was injected, or the reviewer stepped in. */
export interface TimelineMarker {
  tone: "fault" | "reviewer";
  label: string;
  beforeIndex: number; // the experiment it sits above
}

export type TipAction = "keep" | "replace" | "retry_pickup_next_position";
export type WellsAction = "current" | "clean";

export interface ExperimentProposal {
  kind: "experiment";
  flow_rate_uL_per_s: number;
  mixing_cycles: number;
  tip: TipAction;
  wells: WellsAction;
  rationale: string;
  diagnosis?: string;
}


export type Stage =
  | "reviewing_history"
  | "proposing"
  | "awaiting_approval"
  | "reviewing"
  | "running"
  | "evaluating"
  | "awaiting_human"
  | "agent_error"
  | "complete"
  | "aborted";

export const STAGE_TEXT: Record<Stage, string> = {
  reviewing_history: "Reviewing the experiments run so far",
  proposing: "Claude is proposing the next experiment",
  awaiting_approval: "Waiting for you to accept, edit, or reject the hypothesis",
  reviewing: "Reviewer agent is checking the hypothesis",
  running: "Running the experiment on the liquid handler and plate reader",
  evaluating: "Evaluating the plate reader result",
  awaiting_human: "Escalated: a human reviewer must approve the next step",
  agent_error: "Claude is unavailable. Waiting for a human to retry or abort",
  complete: "Run complete",
  aborted: "Run aborted",
};

export type Actor =
  | "reviewer"
  | "agent"
  | "reviewer_agent"
  | "run_loop"
  | "driver"
  | "liquid_handler"
  | "plate_reader";

export interface LabEvent {
  seq: number;
  ts: string;
  runId: string;
  actor: Actor;
  type: string;
  experimentId?: string;
  payload: Record<string, unknown>;
}

export type ExperimentStatus = "proposed" | "running" | "success" | "failure" | "error" | "rejected";

export interface DeviceState {
  liquid_handler: {
    tip_attached: boolean;
    tip_position: number;
    current_wells: string;
    flow_rate_uL_per_s: number;
    mixing_cycles: number;
    last_dispensed_volume_uL: number | null;
    status: string;
  };
  plate_reader: {
    wavelength_nm: number;
    last_readings: number[] | null;
    status: string;
  };
}

export interface ExperimentView {
  id: string;
  index: number;
  proposal: ExperimentProposal;
  status: ExperimentStatus;
  escalation: boolean;
  rmse?: number;
  meanDelivered?: number;
  readings?: number[];
  errorCode?: string;
  errorMessage?: string;
  decidedBy?: string;
  decisionReason?: string;
  edits?: Partial<ExperimentProposal>;
}

export interface RunState {
  runId: string;
  fluidId: FluidId;
  autoMode: boolean;
  stage: Stage;
  experiments: ExperimentView[];
  pendingExperimentId: string | null;
  fault: { kind: FaultKind; active: boolean; detected: boolean; attempts: number; escalated: boolean } | null;
  markers: TimelineMarker[];
  retry: { attempt: number; maxAttempts: number; delayMs: number; error: string } | null;
  agentError: { error: string; attempts: number } | null;
  guidance: string[];
  devices: DeviceState;
  result: {
    bestFlowRate: number;
    bestRmse: number;
    experiments: number;
    confirmedBy: string[]; // the two consecutive successful experiments
    resultFile: string;
    resultJson: string; // the saved file, read back from disk
  } | null;
  abortReason: string | null;
}

export const MAX_FAULT_ATTEMPTS = 3;
export const MAX_EXPERIMENTS = 30;
export const WELL_COUNT = 8;
