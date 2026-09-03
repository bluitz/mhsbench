/**
 * The bench: a simulated liquid handler and plate reader, plus the driver that sits in front of them.
 *
 * Only the Driver talks to the Simulator. The run loop and the agent only ever hold a Driver.
 * Fault injection goes through BenchControl, which stands for a human at the physical bench:
 * the driver and the agent never see it, they only observe the symptoms.
 */
import type { DeviceState, FaultKind, FluidId } from "../../shared/types";

// ---------- Ground truth (hidden from the agent) ----------

// Genentech pilot numbers: water was best at ~140 uL/s (0.016 RMSE), BSA at 10 uL/s (0.181 RMSE).
const PHYSICS: Record<FluidId, { idealFlow: number; floor: number; k: number }> = {
  water: { idealFlow: 140, floor: 0.016, k: 0.02 },
  bsa: { idealFlow: 10, floor: 0.181, k: 0.15 },
};

/** Error model in one line: error grows with how far the flow rate is from ideal, on a log scale. */
export function expectedRmse(fluid: FluidId, flowRate: number): number {
  const { idealFlow, floor, k } = PHYSICS[fluid];
  return floor + k * Math.abs(Math.log(flowRate / idealFlow));
}

const TARGET_VOLUME_UL = 100; // every experiment transfers 100 uL into each of 8 wells
const JITTER = 0.03; // each experiment varies by up to +/-3% so no two are identical
const CLOGGED_DELIVERY = 0.55; // a clogged tip delivers about half the volume
const WELL_GROUPS_PER_PLATE = 12;
const ROW_LETTERS = "ABCDEFGHIJKL";

// ---------- Bench command protocol ----------

export type Device = "liquid_handler" | "plate_reader";

export interface BenchCommand {
  device: Device;
  action: string;
  params: Record<string, unknown>;
}

export type BenchOutcome = { ok: true; data?: Record<string, unknown> } | { ok: false; code: string; message: string };

export interface BenchControl {
  inject(fault: FaultKind): void;
  activeFault(): FaultKind | null;
  setHumanInLoop(v: boolean): void;
}

// ---------- Simulator ----------

export class Simulator implements BenchControl {
  // Physical state of the instruments.
  private tipAttached = false;
  private tipPosition = 1;
  private plateNumber = 1;
  private wellGroup = 1;
  private flowRate = 50;
  private mixingCycles = 3;
  private wavelength = 562;
  private lastDispensedUl: number | null = null;
  private lastDeliveredFractions: number[] | null = null; // fraction of 100 uL that landed in each well
  private lastReadings: number[] | null = null;

  // Injected faults. Set by the human at the bench, invisible to the driver.
  private fault: FaultKind | null = null;
  private badTipPosition: number | null = null; // tip pickup fails at this rack position
  private tipClogged = false;
  private bubblyWells: string | null = null; // which wells currently have bubbles, as 'plate-group'
  private humanInLoop = false;

  constructor(private fluid: FluidId) {}

  // --- BenchControl: the human at the bench ---

  inject(fault: FaultKind): void {
    this.fault = fault;
    if (fault === "tip_pickup_failed") {
      this.tipAttached = false; // the tip is lost, and the next pickup at this position will fail
      this.badTipPosition = this.tipPosition;
    }
    if (fault === "clogged_tip") this.tipClogged = true;
    if (fault === "bubbles") this.bubblyWells = this.wellKey();
  }

  activeFault(): FaultKind | null {
    return this.fault;
  }

  setHumanInLoop(v: boolean): void {
    this.humanInLoop = v;
  }

  // --- What the driver can see ---

  snapshot(): DeviceState {
    const row = ROW_LETTERS[this.wellGroup - 1] ?? "?";
    return {
      liquid_handler: {
        tip_attached: this.tipAttached,
        tip_position: this.tipPosition,
        current_wells: `Plate ${this.plateNumber}, ${row}1-${row}8`,
        flow_rate_uL_per_s: this.flowRate,
        mixing_cycles: this.mixingCycles,
        last_dispensed_volume_uL: this.lastDispensedUl,
        status: this.tipAttached ? "ready" : "no tip",
      },
      plate_reader: { wavelength_nm: this.wavelength, last_readings: this.lastReadings, status: "idle" },
    };
  }

  execute(cmd: BenchCommand): BenchOutcome {
    switch (`${cmd.device}.${cmd.action}`) {
      case "liquid_handler.write":
        if (cmd.params.tag === "flow_rate_uL_per_s") this.flowRate = Number(cmd.params.value);
        if (cmd.params.tag === "mixing_cycles") this.mixingCycles = Number(cmd.params.value);
        return { ok: true };
      case "liquid_handler.pick_up_tip":
        return this.pickUpTip(cmd.params.position === "next");
      case "liquid_handler.eject_tip":
        this.tipAttached = false;
        this.tipClogged = false; // the clog goes away with the tip
        if (this.fault === "clogged_tip") this.fault = null;
        return { ok: true };
      case "liquid_handler.move_to_clean_wells":
        // When the plate is full a fresh plate is loaded, the way a robotic arm would swap it.
        if (this.wellGroup >= WELL_GROUPS_PER_PLATE) {
          this.plateNumber += 1;
          this.wellGroup = 1;
        } else {
          this.wellGroup += 1;
        }
        return { ok: true };
      case "liquid_handler.transfer":
        return this.transfer();
      case "liquid_handler.mix":
        return this.mix();
      case "plate_reader.write":
        if (cmd.params.tag === "wavelength_nm") this.wavelength = Number(cmd.params.value);
        return { ok: true };
      case "plate_reader.read_absorbance":
        return this.readAbsorbance();
      default:
        return { ok: false, code: "E-000", message: `Unknown command ${cmd.device}.${cmd.action}` };
    }
  }

  private wellKey(): string {
    return `${this.plateNumber}-${this.wellGroup}`;
  }

  private pickUpTip(advance: boolean): BenchOutcome {
    if (advance) this.tipPosition += 1;
    if (this.badTipPosition === this.tipPosition) {
      return {
        ok: false,
        code: "E-101",
        message: "TIP_PICKUP_FAILED: the tip at this rack position could not be seated. No liquid moved.",
      };
    }
    this.tipAttached = true;
    this.badTipPosition = null;
    if (this.fault === "tip_pickup_failed") this.fault = null;
    return { ok: true };
  }

  /** Simulation rule for bubbles: nothing clears them until a human is in the loop. */
  private bubblesBlockTransfer(): BenchOutcome | null {
    if (this.fault !== "bubbles") return null;
    const inCleanWells = this.wellKey() !== this.bubblyWells;
    const gentleMixing = this.mixingCycles <= 1;
    if (this.humanInLoop && inCleanWells && gentleMixing) {
      this.fault = null;
      return null;
    }
    this.bubblyWells = this.wellKey(); // the wells just used are bubbly now too
    this.lastDeliveredFractions = null;
    this.lastDispensedUl = null;
    return {
      ok: false,
      code: "E-217",
      message: "FLUID_DETECTION_ERROR: the liquid level sensor could not find a stable surface in the target wells. Transfer aborted.",
    };
  }

  private transfer(): BenchOutcome {
    if (!this.tipAttached) return { ok: false, code: "E-102", message: "NO_TIP: cannot transfer without a tip." };
    const blocked = this.bubblesBlockTransfer();
    if (blocked) return blocked;

    const spread = expectedRmse(this.fluid, this.flowRate);
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
    const clogFactor = this.tipClogged ? CLOGGED_DELIVERY : 1;
    // The 8 wells land alternately above and below the target by `spread`, so their RMSE equals spread.
    const signs = [1, -1, 1, -1, 1, -1, 1, -1];
    this.lastDeliveredFractions = signs.map((sign) => clogFactor * (1 + sign * spread * jitter));
    const averageFraction = this.lastDeliveredFractions.reduce((a, b) => a + b, 0) / signs.length;
    this.lastDispensedUl = Math.round(TARGET_VOLUME_UL * averageFraction * 10) / 10;
    return { ok: true, data: { dispensed_volume_uL: this.lastDispensedUl } };
  }

  private mix(): BenchOutcome {
    if (!this.tipAttached) return { ok: false, code: "E-102", message: "NO_TIP: cannot mix without a tip." };
    const blocked = this.bubblesBlockTransfer();
    if (blocked) return blocked;
    return { ok: true, data: { cycles: this.mixingCycles } };
  }

  private readAbsorbance(): BenchOutcome {
    if (!this.lastDeliveredFractions) {
      return { ok: false, code: "E-401", message: "NO_SAMPLE: the target wells contain no dispensed liquid." };
    }
    // Absorbance is proportional to delivered volume. A perfect 100 uL transfer reads 1.000.
    this.lastReadings = this.lastDeliveredFractions.map((f) => Math.round(f * 1000) / 1000);
    return { ok: true, data: { readings: this.lastReadings, expected: 1.0 } };
  }
}

// ---------- Driver: MHS-style manifest plus enforcement ----------

export interface ManifestEntry {
  kind: "write" | "action";
  name: string;
  description: string;
  min?: number;
  max?: number;
}

export const LIQUID_HANDLER_MANIFEST: ManifestEntry[] = [
  { kind: "write", name: "flow_rate_uL_per_s", min: 5, max: 250, description: "Aspirate and dispense flow rate. Values outside the range are rejected by the driver." },
  { kind: "write", name: "mixing_cycles", min: 0, max: 10, description: "Aspirate/dispense cycles used to mix after a transfer. 0 disables mixing." },
  { kind: "action", name: "pick_up_tip", description: "Seat a tip from the rack. position 'same' retries the current rack position, 'next' advances. May fail with E-101 TIP_PICKUP_FAILED." },
  { kind: "action", name: "eject_tip", description: "Discard the attached tip." },
  { kind: "action", name: "transfer", description: "Transfer 100 uL of dyed liquid into the 8 current wells at the current flow rate. May fail with E-217 FLUID_DETECTION_ERROR." },
  { kind: "action", name: "mix", description: "Mix the current wells using mixing_cycles cycles." },
  { kind: "action", name: "move_to_clean_wells", description: "Advance to the next unused group of 8 wells. When the plate is full a fresh plate is loaded." },
];

export const PLATE_READER_MANIFEST: ManifestEntry[] = [
  { kind: "write", name: "wavelength_nm", min: 400, max: 700, description: "Measurement wavelength." },
  { kind: "action", name: "read_absorbance", description: "Read absorbance of the 8 current wells. A correct 100 uL transfer reads 1.000." },
];

/** The manifest as text, given to the agent as its description of the devices. */
export function manifestText(): string {
  const line = (e: ManifestEntry) =>
    e.kind === "write"
      ? `- write ${e.name} (allowed ${e.min} to ${e.max}): ${e.description}`
      : `- action ${e.name}: ${e.description}`;
  return ["Liquid handler:", ...LIQUID_HANDLER_MANIFEST.map(line), "Plate reader:", ...PLATE_READER_MANIFEST.map(line)].join("\n");
}

export interface DriverResult {
  ok: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  state: DeviceState; // device snapshot after the command, so the UI can show instrument state
}

export interface CommandRecord {
  device: Device;
  action: string;
  params: Record<string, unknown>;
  result: DriverResult;
}

/** The only object that holds a reference to the simulator. Enforces the manifest before anything reaches the bench. */
export class Driver {
  // Live limits start from the manifest. An operator can tighten one during a run; the agent's reference text does not change.
  private limits = new Map<string, { min: number; max: number; changedByOperator: boolean }>();

  constructor(
    private bench: Simulator,
    private onCommand: (record: CommandRecord) => void,
  ) {
    for (const entry of [...LIQUID_HANDLER_MANIFEST, ...PLATE_READER_MANIFEST]) {
      if (entry.kind === "write") this.limits.set(entry.name, { min: entry.min!, max: entry.max!, changedByOperator: false });
    }
  }

  setLimit(tag: string, max: number): void {
    const limit = this.limits.get(tag);
    if (!limit) return;
    limit.max = max;
    limit.changedByOperator = true;
  }

  snapshot(): DeviceState {
    return this.bench.snapshot();
  }

  write(device: Device, tag: string, value: number): DriverResult {
    const known = this.manifest(device).some((e) => e.kind === "write" && e.name === tag);
    const limit = this.limits.get(tag);
    let result: DriverResult;
    if (!known || !limit) {
      result = this.reject(`No writable tag named ${tag}.`);
    } else if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
      const note = limit.changedByOperator ? " (the operator lowered the limit during this run)" : "";
      result = this.reject(`${tag}=${value} is outside the allowed range ${limit.min} to ${limit.max}${note}. Not sent to the device.`);
    } else {
      result = this.send({ device, action: "write", params: { tag, value } });
    }
    this.onCommand({ device, action: `write ${tag}`, params: { value }, result });
    return result;
  }

  call(device: Device, action: string, params: Record<string, unknown> = {}): DriverResult {
    const known = this.manifest(device).some((e) => e.kind === "action" && e.name === action);
    const result = known ? this.send({ device, action, params }) : this.reject(`No action named ${action}.`);
    this.onCommand({ device, action, params, result });
    return result;
  }

  private manifest(device: Device): ManifestEntry[] {
    return device === "liquid_handler" ? LIQUID_HANDLER_MANIFEST : PLATE_READER_MANIFEST;
  }

  private reject(message: string): DriverResult {
    return { ok: false, code: "DRIVER_REJECTED", message, state: this.bench.snapshot() };
  }

  private send(cmd: BenchCommand): DriverResult {
    const outcome = this.bench.execute(cmd);
    return { ...outcome, state: this.bench.snapshot() };
  }
}
