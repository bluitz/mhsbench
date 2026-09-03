/**
 * The whole user interface in one file. Everything on screen is a fold of the event stream,
 * so replaying a run is just folding fewer events.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FLUID_CARDS, FLUID_LIST } from "../shared/fluids";
import { faultAttemptText, fold } from "../shared/reducer";
import {
  FAULT_DESCRIPTIONS,
  MAX_FAULT_ATTEMPTS,
  STAGE_TEXT,
  type ExperimentProposal,
  type ExperimentView,
  type FaultKind,
  type FluidId,
  type LabEvent,
  type RunState,
} from "../shared/types";

const GUIDANCE_PRESETS = [
  "The error is caused by bubbles in the liquid. Move to clean wells and reduce mixing cycles to 1 or 0.",
  "Replace the tip before the next transfer.",
  "Slow down: try a lower flow rate.",
];

const REPLAY_STEP_MS = 400;

// ---------- Talking to the server ----------

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) window.alert(data.error ?? "Request failed");
  return data;
}

function runIdFromHash(): string | null {
  const match = window.location.hash.match(/run=([a-z0-9-]+)/);
  return match ? match[1]! : null;
}

// ---------- App ----------

export function App() {
  const [runId, setRunId] = useState<string | null>(runIdFromHash);
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [replayCount, setReplayCount] = useState<number | null>(null); // null = live, otherwise how many events are shown
  const [inspectedId, setInspectedId] = useState<string | null>(null); // an experiment card clicked to view its hypothesis

  // Follow the URL hash so a page reload, or a second tab, lands on its own run.
  useEffect(() => {
    const onHash = () => {
      setRunId(runIdFromHash());
      setEvents([]);
      setReplayCount(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // One Server-Sent Events connection per run. The browser reconnects and resumes by itself.
  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.addEventListener("lab", (message) => {
      const event = JSON.parse((message as MessageEvent).data) as LabEvent;
      setEvents((prev) => (prev.length && event.seq <= prev[prev.length - 1]!.seq ? prev : [...prev, event]));
      // A finished run sends nothing more, so stop listening instead of reconnecting forever.
      const stage = event.type === "loop.stage_changed" ? event.payload.stage : null;
      if (stage === "complete" || stage === "aborted") source.close();
    });
    return () => source.close();
  }, [runId]);

  // Replay: reveal one more event every few hundred milliseconds.
  useEffect(() => {
    if (replayCount === null || replayCount >= events.length) return;
    const timer = setTimeout(() => setReplayCount(replayCount + 1), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [replayCount, events.length]);

  const visibleEvents = replayCount === null ? events : events.slice(0, replayCount);
  const state = useMemo(() => fold(runId ?? "", "water", false, visibleEvents), [runId, visibleEvents]);
  const replaying = replayCount !== null;
  const ended = state.stage === "complete" || state.stage === "aborted";
  const inspected = state.experiments.find((x) => x.id === inspectedId) ?? null;

  // A new hypothesis takes over the panel, so an old card being inspected does not get stuck there.
  useEffect(() => setInspectedId(null), [state.pendingExperimentId]);

  return (
    <div className="page">
      <style>{CSS}</style>
      <Header runId={runId} state={state} replaying={replaying} />
      {runId && (
        <>
          <NowBanner state={state} runId={runId} disabled={replaying || ended} />
          <Timeline state={state} inspectedId={inspectedId} onInspect={setInspectedId} />
          <div className="columns">
            <HypothesisPanel
              state={state}
              runId={runId}
              disabled={replaying || ended}
              inspected={inspected}
              onCloseInspect={() => setInspectedId(null)}
            />
            <Instruments state={state} runId={runId} disabled={replaying || ended} />
          </div>
          <EventLog
            events={visibleEvents}
            replaying={replaying}
            onReplay={() => setReplayCount(replaying ? null : 0)}
          />
        </>
      )}
    </div>
  );
}

// ---------- Header: pick a sample and start, or show the running sample ----------

function Header({ runId, state, replaying }: { runId: string | null; state: RunState; replaying: boolean }) {
  const [fluidId, setFluidId] = useState<FluidId>("bsa");
  const [autoMode, setAutoMode] = useState(false);

  async function start() {
    const data = await post("/api/runs", { protein_id: fluidId, auto_mode: autoMode });
    if (data.ok) window.location.hash = `run=${data.run_id}`;
  }

  return (
    <header className="panel">
      <div className="title-row">
        <div>
          <h1>MHS Bench</h1>
          <p className="muted">
            A Claude agent finds the best liquid handler flow rate for a protein sample by running experiments on a simulated
            bench. Inject faults, approve or reject its hypotheses, and watch it recover.
          </p>
        </div>
        {runId && (
          <div className="badges">
            <span className="badge">Sample: {FLUID_CARDS[state.fluidId].name}</span>
            <span className="badge" title="Claude reads the experiments so far and proposes the next flow rate, mixing cycles, tip action and wells as one JSON hypothesis.">
              Agent: Claude
            </span>
            {replaying && <span className="badge replay">Replaying this run</span>}
            <a className="button secondary" href="#">
              New run
            </a>
          </div>
        )}
      </div>

      {!runId && (
        <div className="start-row">
          <div>
            <h2>1. Choose a sample</h2>
            <p className="muted">From a simple aqueous reagent to a viscous, foamy protein.</p>
            <div className="sample-cards">
              {FLUID_LIST.map((f) => (
                <label key={f.id} className={`sample-card ${fluidId === f.id ? "selected" : ""}`}>
                  <input type="radio" name="fluid" checked={fluidId === f.id} onChange={() => setFluidId(f.id)} />
                  <strong>{f.name}</strong>
                  <span>{f.character}</span>
                  <small>{f.description}</small>
                  <small>Assay tolerance: RMSE at or below {f.tolerance}. This is a simulation, not real fluid physics.</small>
                </label>
              ))}
            </div>
          </div>
          <div>
            <h2>2. Choose who approves hypotheses</h2>
            <AutoModeToggle autoMode={autoMode} onChange={setAutoMode} />
            <button className="button primary large" onClick={start}>
              Start run
            </button>
          </div>
        </div>
      )}

      {runId && (
        <AutoModeToggle autoMode={state.autoMode} onChange={(v) => post(`/api/runs/${runId}/mode`, { auto_mode: v })} />
      )}
    </header>
  );
}

function AutoModeToggle({ autoMode, onChange }: { autoMode: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={autoMode} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Auto mode {autoMode ? "on" : "off"}.</strong>{" "}
        {autoMode
          ? "A reviewer agent accepts or rejects each hypothesis and experiments run without you."
          : "You accept, edit, or reject each hypothesis before it runs."}{" "}
        Escalations after {MAX_FAULT_ATTEMPTS} failed recovery attempts always wait for you.
      </span>
    </label>
  );
}

// ---------- Now banner: what is happening right now, readable from across the room ----------

function NowBanner({ state, runId, disabled }: { state: RunState; runId: string; disabled: boolean }) {
  const faultText = faultAttemptText(state);
  return (
    <section className={`now stage-${state.stage}`}>
      <div className="now-label">Now</div>
      <div className="now-text">{STAGE_TEXT[state.stage]}</div>
      {state.retry && (
        <div className="now-detail">
          Claude API error, retry {state.retry.attempt} of {state.retry.maxAttempts}, waiting {Math.round(state.retry.delayMs / 1000)} s.
          Error: {state.retry.error}
        </div>
      )}
      {state.agentError && (
        <div className="now-detail error-box">
          <div>
            Claude did not answer after {state.agentError.attempts} attempts over about a minute. Last error: {state.agentError.error}
          </div>
          <div className="button-row">
            <button className="button primary" disabled={disabled} onClick={() => post(`/api/runs/${runId}/retry`)}>
              Retry agent
            </button>
            <button className="button danger" disabled={disabled} onClick={() => post(`/api/runs/${runId}/abort`, { reason: "Aborted after agent failure" })}>
              Abort run
            </button>
          </div>
        </div>
      )}
      {faultText && <div className={`now-detail ${state.fault?.escalated ? "escalated" : "fault"}`}>{faultText}</div>}
      {state.result && (
        <div className="now-detail success">
          Best flow rate {state.result.bestFlowRate} µL/s with RMSE {state.result.bestRmse} after {state.result.experiments} experiments.
        </div>
      )}
      {state.abortReason && <div className="now-detail error-box">{state.abortReason}</div>}
    </section>
  );
}

// ---------- Timeline: one card per experiment, colored by status ----------

function Timeline({ state, inspectedId, onInspect }: { state: RunState; inspectedId: string | null; onInspect: (id: string) => void }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const currentId = state.pendingExperimentId ?? state.experiments.find((x) => x.status === "running")?.id ?? state.experiments.at(-1)?.id;

  // Keep the previous, current, and proposed experiments in view.
  useEffect(() => {
    const card = stripRef.current?.querySelector<HTMLElement>('[data-current="true"]');
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentId, state.experiments.length]);

  return (
    <section className="panel">
      <h2>Experiment timeline</h2>
      <p className="muted">Every hypothesis the agent proposed, in order. Color shows its status. Click one to see the hypothesis behind it.</p>
      <div className="legend">
        {(["proposed", "running", "success", "failure", "error", "rejected"] as const).map((s) => (
          <span key={s} className={`chip status-${s}`}>
            {s}
          </span>
        ))}
      </div>
      <div className="strip" ref={stripRef}>
        {state.experiments.length === 0 && <div className="muted">No experiments yet.</div>}
        {state.experiments.map((x) => (
          <ExperimentCard key={x.id} x={x} current={x.id === currentId} inspected={x.id === inspectedId} onClick={() => onInspect(x.id)} />
        ))}
      </div>
    </section>
  );
}

function ExperimentCard({ x, current, inspected, onClick }: { x: ExperimentView; current: boolean; inspected: boolean; onClick: () => void }) {
  const p = x.proposal;
  return (
    <div
      className={`card status-${x.status} ${current ? "current" : ""} ${inspected ? "inspected" : ""}`}
      data-current={current}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      <div className="card-head">
        <span>#{x.index}</span>
        <span className="status-label">{x.status}</span>
      </div>
      <div className="card-big">{p.flow_rate_uL_per_s} µL/s</div>
      <div className="card-line">Mixing cycles: {p.mixing_cycles}</div>
      {p.tip !== "keep" && <div className="card-line">Tip: {p.tip.replaceAll("_", " ")}</div>}
      {p.wells === "clean" && <div className="card-line">Moves to clean wells</div>}
      {x.rmse !== undefined && x.rmse !== null && <div className="card-line">RMSE {x.rmse}</div>}
      {x.errorCode && <div className="card-line">Error {x.errorCode}</div>}
      {x.status === "rejected" && <div className="card-line">Rejected: {x.decisionReason}</div>}
      {x.escalation && <div className="card-line tag">Escalation</div>}
    </div>
  );
}

// ---------- Hypothesis panel: accept, edit, reject, or guide ----------

function HypothesisPanel({
  state,
  runId,
  disabled,
  inspected,
  onCloseInspect,
}: {
  state: RunState;
  runId: string;
  disabled: boolean;
  inspected: ExperimentView | null;
  onCloseInspect: () => void;
}) {
  const pending = state.experiments.find((x) => x.id === state.pendingExperimentId);
  // A clicked card shows its hypothesis read-only. Otherwise the panel shows the live one waiting for a decision.
  const shown = inspected ?? pending;
  const readOnly = inspected !== null && inspected.id !== pending?.id;
  const [edits, setEdits] = useState<Partial<ExperimentProposal>>({});
  const [reason, setReason] = useState("");

  // Start each hypothesis with a clean edit form.
  useEffect(() => {
    setEdits({});
    setReason("");
  }, [shown?.id]);

  const faultActive = Boolean(state.fault?.active && state.fault.detected);
  const humanDecides = !readOnly && pending !== undefined && (pending.escalation || !state.autoMode);
  const changed = Object.keys(edits).length > 0;

  function decide(decision: "accept" | "reject") {
    post(`/api/runs/${runId}/decision`, {
      experiment_id: pending!.id,
      decision,
      edits: decision === "accept" && changed ? edits : undefined,
      reason: reason || undefined,
    });
  }

  return (
    <section className="panel">
      <div className="title-row">
        <div>
          <h2>{readOnly ? `Hypothesis behind experiment #${inspected?.index}` : "Current hypothesis"}</h2>
          <p className="muted">
            {readOnly
              ? "The agent's reasoning for this experiment, the parameters it chose, and what the reviewer decided."
              : "What the agent wants to run next and its reasoning. You can accept it, change the numbers, or send it back."}
          </p>
        </div>
        {readOnly && (
          <button className="button secondary" onClick={onCloseInspect}>
            Back to current hypothesis
          </button>
        )}
      </div>

      {faultActive && !readOnly && (
        <div className="guidance">
          <strong>Guide the agent.</strong> Sending guidance replaces the pending hypothesis and the agent re-plans with it.
          <div className="button-row">
            {GUIDANCE_PRESETS.map((text) => (
              <button key={text} className="button secondary" disabled={disabled} onClick={() => post(`/api/runs/${runId}/guidance`, { text })}>
                {text}
              </button>
            ))}
          </div>
        </div>
      )}

      {!shown && <div className="muted">No hypothesis is waiting right now. Click an experiment above to see the hypothesis behind it.</div>}

      {shown && (
        <div className={`hypothesis ${shown.escalation ? "escalated" : ""}`}>
          {shown.escalation && <div className="tag">Escalation: human approval required</div>}
          <div className="rationale">
            <strong>Reasoning:</strong> {shown.proposal.rationale}
          </div>
          {shown.proposal.diagnosis && (
            <div className="rationale">
              <strong>Diagnosis:</strong> {shown.proposal.diagnosis}
            </div>
          )}
          <div className="edit-grid">
            <label>
              Flow rate (µL/s)
              <input
                type="number"
                min={5}
                max={250}
                disabled={!humanDecides || disabled}
                value={edits.flow_rate_uL_per_s ?? shown.proposal.flow_rate_uL_per_s}
                onChange={(e) => setEdits({ ...edits, flow_rate_uL_per_s: Number(e.target.value) })}
              />
            </label>
            <label>
              Mixing cycles
              <input
                type="number"
                min={0}
                max={10}
                disabled={!humanDecides || disabled}
                value={edits.mixing_cycles ?? shown.proposal.mixing_cycles}
                onChange={(e) => setEdits({ ...edits, mixing_cycles: Number(e.target.value) })}
              />
            </label>
            <label>
              Tip
              <select
                disabled={!humanDecides || disabled}
                value={edits.tip ?? shown.proposal.tip}
                onChange={(e) => setEdits({ ...edits, tip: e.target.value as ExperimentProposal["tip"] })}
              >
                <option value="keep">keep</option>
                <option value="replace">replace</option>
                <option value="retry_pickup_next_position">retry pickup at next position</option>
              </select>
            </label>
            <label>
              Wells
              <select
                disabled={!humanDecides || disabled}
                value={edits.wells ?? shown.proposal.wells}
                onChange={(e) => setEdits({ ...edits, wells: e.target.value as ExperimentProposal["wells"] })}
              >
                <option value="current">current</option>
                <option value="clean">clean</option>
              </select>
            </label>
          </div>
          {readOnly ? (
            <div className="muted">{decisionSummary(shown)}</div>
          ) : humanDecides ? (
            <>
              <input
                className="reason"
                placeholder="Reason (optional, shown to the agent if you reject)"
                value={reason}
                disabled={disabled}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="button-row">
                <button className="button primary" disabled={disabled} onClick={() => decide("accept")}>
                  {changed ? "Accept with edits" : "Accept"}
                </button>
                <button className="button danger" disabled={disabled} onClick={() => decide("reject")}>
                  Reject
                </button>
              </div>
            </>
          ) : (
            <div className="muted">Auto mode: the reviewer agent is deciding.</div>
          )}
        </div>
      )}
    </section>
  );
}

/** One line on what the reviewer did with a past hypothesis. */
function decisionSummary(x: ExperimentView): string {
  const by = (x.decidedBy ?? "").replaceAll("_", " ");
  if (x.status === "rejected") return `Rejected by the ${by}: ${x.decisionReason ?? "no reason given"}.`;
  if (x.decidedBy) return `Accepted by the ${by}${x.edits ? " with edits" : ""}.`;
  return "Waiting for a decision.";
}

// ---------- Instruments and fault injection ----------

function Instruments({ state, runId, disabled }: { state: RunState; runId: string; disabled: boolean }) {
  const lh = state.devices.liquid_handler;
  const pr = state.devices.plate_reader;
  const faultBusy = Boolean(state.fault?.active);

  return (
    <section className="panel">
      <h2>Instruments</h2>
      <p className="muted">Live state of the two simulated devices, as reported by their drivers.</p>
      <div className="devices">
        <div>
          <h3>Liquid handler</h3>
          <table>
            <tbody>
              <tr><td>Status</td><td>{lh.status}</td></tr>
              <tr><td>Tip attached</td><td>{lh.tip_attached ? "yes" : "no"} (rack position {lh.tip_position})</td></tr>
              <tr><td>Current wells</td><td>{lh.current_wells}</td></tr>
              <tr><td>Flow rate</td><td>{lh.flow_rate_uL_per_s} µL/s</td></tr>
              <tr><td>Mixing cycles</td><td>{lh.mixing_cycles}</td></tr>
              <tr><td>Last dispensed</td><td>{lh.last_dispensed_volume_uL ?? "–"} µL of 100</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <h3>Plate reader</h3>
          <table>
            <tbody>
              <tr><td>Wavelength</td><td>{pr.wavelength_nm} nm</td></tr>
              <tr><td>Last readings</td><td>{pr.last_readings ? pr.last_readings.join(", ") : "–"}</td></tr>
            </tbody>
          </table>
          <p className="muted small">A perfect 100 µL transfer reads 1.000 in every well.</p>
        </div>
      </div>

      <h3>Inject a fault</h3>
      <p className="muted">Break something on the bench and watch the driver, the agent, and the loop respond.</p>
      {faultBusy && <p className="muted">A fault is active. The buttons come back once it is recovered.</p>}
      <div className="fault-buttons">
        {(Object.keys(FAULT_DESCRIPTIONS) as FaultKind[]).map((kind) => (
          <button
            key={kind}
            className="button fault"
            disabled={disabled || faultBusy}
            onClick={() => post(`/api/runs/${runId}/faults`, { fault: kind })}
          >
            <strong>{FAULT_DESCRIPTIONS[kind].title}</strong>
            <small>{FAULT_DESCRIPTIONS[kind].description}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------- Event log ----------

function EventLog({ events, replaying, onReplay }: { events: LabEvent[]; replaying: boolean; onReplay: () => void }) {
  return (
    <section className="panel">
      <div className="title-row">
        <div>
          <h2>Event log</h2>
          <p className="muted">Every event in this run, newest first. The whole screen is computed from this list.</p>
        </div>
        <button className="button secondary" onClick={onReplay}>
          {replaying ? "Stop replay and return to live" : "Replay this run"}
        </button>
      </div>
      <div className="log">
        {[...events].reverse().map((e) => (
          <div key={e.seq} className="log-row">
            <span className="seq">{e.seq}</span>
            <span className="time">{e.ts.slice(11, 19)}</span>
            <span className="actor">{e.actor}</span>
            <span className="type">{e.type}</span>
            <span className="summary">{summarize(e)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function summarize(e: LabEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case "hypothesis.proposed":
      return p.proposal.kind === "experiment" ? `${p.proposal.flow_rate_uL_per_s} µL/s, mixing ${p.proposal.mixing_cycles}, tip ${p.proposal.tip}, wells ${p.proposal.wells}` : "conclude";
    case "hypothesis.accepted":
      return p.edits ? `by ${p.by} with edits ${JSON.stringify(p.edits)}` : `by ${p.by}`;
    case "hypothesis.rejected":
      return `by ${p.by}: ${p.reason}`;
    case "experiment.completed":
      return p.errorCode ? `${p.status} ${p.errorCode}` : `${p.status}, RMSE ${p.rmse}, mean delivered ${p.meanDelivered}`;
    case "driver.command":
      return `${p.device}.${p.action} ${JSON.stringify(p.params)}`;
    case "driver.error":
      return `${p.code}: ${p.message}`;
    case "driver.rejected":
      return p.message;
    case "loop.stage_changed":
      return STAGE_TEXT[p.stage as keyof typeof STAGE_TEXT] ?? p.stage;
    case "fault.injected":
      return FAULT_DESCRIPTIONS[p.fault as FaultKind].title;
    case "fault.attempt":
      return `attempt ${p.n} of ${p.max}`;
    case "agent.api_retry":
      return `attempt ${p.attempt}, waiting ${p.delayMs} ms: ${p.error}`;
    case "guidance.provided":
      return p.text;
    case "run.completed":
      return `best ${p.bestFlowRate} µL/s, RMSE ${p.bestRmse}`;
    case "driver.result":
      return p.data ? JSON.stringify(p.data) : "";
    default:
      return Object.keys(p).length ? JSON.stringify(p) : "";
  }
}

// ---------- Styles ----------

const CSS = `
  :root { --proposed: #3b5bdb; --running: #0d9488; --success: #16a34a; --failure: #ea580c; --error: #dc2626; --rejected: #6b7280; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; background: #f3f4f6; color: #111827; }
  .page { max-width: 1400px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
  .panel { background: white; border-radius: 12px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { margin: 0 0 4px; font-size: 28px; } h2 { margin: 0 0 4px; font-size: 18px; } h3 { margin: 12px 0 6px; font-size: 15px; }
  .muted { color: #6b7280; margin: 0 0 10px; } .small { font-size: 12px; }
  .title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .badge { background: #eef2ff; color: #3730a3; padding: 6px 10px; border-radius: 999px; font-size: 13px; }
  .badge.replay { background: #fef3c7; color: #92400e; }
  .start-row { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; margin-top: 12px; }
  .sample-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .sample-card { display: grid; gap: 4px; padding: 12px; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer; }
  .sample-card.selected { border-color: var(--proposed); background: #eef2ff; }
  .sample-card small { color: #6b7280; }
  .toggle { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid #e5e7eb; border-radius: 10px; margin: 8px 0; cursor: pointer; }
  .toggle input { margin-top: 3px; transform: scale(1.3); }
  .button { border: none; border-radius: 8px; padding: 10px 14px; font-size: 14px; cursor: pointer; background: #e5e7eb; color: #111827; text-decoration: none; display: inline-block; }
  .button:disabled { opacity: 0.45; cursor: not-allowed; }
  .button.primary { background: var(--proposed); color: white; } .button.danger { background: var(--error); color: white; }
  .button.secondary { background: #e5e7eb; } .button.large { font-size: 18px; padding: 14px 22px; margin-top: 8px; }
  .button-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .now { border-radius: 12px; padding: 18px 22px; color: white; background: #374151; display: grid; gap: 6px; }
  .now-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.8; }
  .now-text { font-size: 28px; font-weight: 600; }
  .now-detail { font-size: 16px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,0.15); }
  .now-detail.fault { background: #b45309; } .now-detail.escalated { background: #991b1b; } .now-detail.success { background: #166534; }
  .now-detail.error-box { background: #7f1d1d; }
  .stage-proposing, .stage-reviewing_history, .stage-reviewing { background: #1e3a8a; }
  .stage-awaiting_approval { background: #5b21b6; } .stage-running, .stage-evaluating { background: #0f766e; }
  .stage-awaiting_human { background: #991b1b; } .stage-agent_error { background: #7f1d1d; } .stage-complete { background: #166534; }
  .legend { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .chip { padding: 3px 10px; border-radius: 999px; font-size: 12px; color: white; }
  .chip.status-proposed { background: var(--proposed); } .chip.status-running { background: var(--running); } .chip.status-success { background: var(--success); }
  .chip.status-failure { background: var(--failure); } .chip.status-error { background: var(--error); } .chip.status-rejected { background: var(--rejected); }
  .strip { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 4px 12px; }
  .card { flex: 0 0 190px; border-radius: 10px; padding: 10px 12px; color: white; display: grid; gap: 3px; font-size: 13px; cursor: pointer; }
  .card.inspected { box-shadow: 0 0 0 3px #1d4ed8; }
  .card.current { outline: 3px solid #111827; outline-offset: 2px; }
  .card.status-proposed { background: var(--proposed); } .card.status-running { background: var(--running); animation: pulse 1.2s infinite; }
  .card.status-success { background: var(--success); } .card.status-failure { background: var(--failure); } .card.status-error { background: var(--error); }
  .card.status-rejected { background: var(--rejected); opacity: 0.85; }
  .card-head { display: flex; justify-content: space-between; font-weight: 600; } .status-label { text-transform: uppercase; font-size: 11px; }
  .card-big { font-size: 22px; font-weight: 700; } .card-line { opacity: 0.95; }
  .tag { display: inline-block; background: #111827; color: white; padding: 2px 8px; border-radius: 6px; font-size: 12px; margin-bottom: 6px; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
  .columns { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 16px; }
  .hypothesis { border: 2px solid var(--proposed); border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
  .hypothesis.escalated { border-color: var(--error); background: #fef2f2; }
  .rationale { font-size: 15px; line-height: 1.4; }
  .edit-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .edit-grid label { display: grid; gap: 4px; font-size: 12px; color: #6b7280; }
  input, select { padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; width: 100%; }
  input[type=checkbox], input[type=radio] { width: auto; padding: 0; }
  .reason { margin-top: 4px; }
  .guidance { background: #fffbeb; border: 1px solid #f59e0b; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
  .devices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } td { padding: 4px 6px; border-bottom: 1px solid #f3f4f6; } td:first-child { color: #6b7280; width: 45%; }
  .fault-buttons { display: grid; gap: 8px; }
  .button.fault { text-align: left; display: grid; gap: 2px; background: #fef2f2; border: 1px solid #fecaca; } .button.fault small { color: #6b7280; }
  .log { max-height: 320px; overflow-y: auto; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .log-row { display: grid; grid-template-columns: 50px 70px 110px 190px 1fr; gap: 8px; padding: 3px 0; border-bottom: 1px solid #f3f4f6; }
  .seq, .time { color: #9ca3af; } .actor { color: #6b7280; } .type { color: #1f2937; font-weight: 600; } .summary { color: #374151; word-break: break-word; }
  @media (max-width: 900px) { .columns, .start-row, .sample-cards, .devices { grid-template-columns: 1fr; } .edit-grid { grid-template-columns: 1fr 1fr; } }
`;
