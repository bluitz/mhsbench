import { describe, expect, test } from "bun:test";
import { Driver, Simulator, expectedRmse } from "../src/server/lab/bench";
import { FLUID_CARDS } from "../src/shared/fluids";
import { meanDeliveredOf, rmseOf } from "../src/shared/score";

/** Run one experiment the way the loop does: pick up a tip if needed, set flow, transfer, read. */
function experiment(driver: Driver, flowRate: number) {
  if (!driver.snapshot().liquid_handler.tip_attached) driver.call("liquid_handler", "pick_up_tip", { position: "same" });
  driver.write("liquid_handler", "flow_rate_uL_per_s", flowRate);
  const transfer = driver.call("liquid_handler", "transfer");
  if (!transfer.ok) return { error: transfer.code };
  const read = driver.call("plate_reader", "read_absorbance");
  const readings = read.data!.readings as number[];
  return { rmse: rmseOf(readings), meanDelivered: meanDeliveredOf(readings) };
}

function bench(fluid: "water" | "bsa") {
  const sim = new Simulator(fluid);
  const driver = new Driver(sim, () => {});
  return { sim, driver };
}

describe("error model", () => {
  test("is lowest at the ideal flow rate and grows with log distance", () => {
    expect(expectedRmse("water", 140)).toBeCloseTo(0.016, 4);
    expect(expectedRmse("water", 280)).toBeCloseTo(0.016 + 0.02 * Math.log(2), 4);
    expect(expectedRmse("water", 70)).toBeCloseTo(0.016 + 0.02 * Math.log(2), 4);
    expect(expectedRmse("bsa", 10)).toBeCloseTo(0.181, 4);
  });

  test("an experiment at the ideal flow rate passes the published tolerance", () => {
    const { driver } = bench("bsa");
    const result = experiment(driver, 10);
    expect(result.rmse!).toBeLessThanOrEqual(FLUID_CARDS.bsa.tolerance);
  });

  test("an experiment far from the ideal flow rate fails the tolerance", () => {
    const { driver } = bench("bsa");
    expect(experiment(driver, 140).rmse!).toBeGreaterThan(FLUID_CARDS.bsa.tolerance);
  });
});

describe("driver", () => {
  test("rejects an out-of-range flow rate without changing the device", () => {
    const { driver } = bench("water");
    const result = driver.write("liquid_handler", "flow_rate_uL_per_s", 500);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("DRIVER_REJECTED");
    expect(driver.snapshot().liquid_handler.flow_rate_uL_per_s).toBe(50);
  });
});

describe("faults", () => {
  test("tip pickup fails at the same position and succeeds at the next", () => {
    const { sim, driver } = bench("water");
    sim.inject("tip_pickup_failed");
    expect(driver.call("liquid_handler", "pick_up_tip", { position: "same" }).code).toBe("E-101");
    expect(driver.call("liquid_handler", "pick_up_tip", { position: "next" }).ok).toBe(true);
    expect(sim.activeFault()).toBeNull();
  });

  test("clogged tip under-delivers regardless of flow rate until the tip is replaced", () => {
    const { sim, driver } = bench("water");
    sim.inject("clogged_tip");
    expect(experiment(driver, 140).meanDelivered!).toBeLessThan(0.7);
    expect(experiment(driver, 40).meanDelivered!).toBeLessThan(0.7);
    driver.call("liquid_handler", "eject_tip");
    expect(sim.activeFault()).toBeNull();
    expect(experiment(driver, 140).meanDelivered!).toBeGreaterThan(0.9);
  });

  test("bubbles block every transfer until a human is in the loop, wells are clean, and mixing is gentle", () => {
    const { sim, driver } = bench("bsa");
    sim.inject("bubbles");
    expect(experiment(driver, 10).error).toBe("E-217");
    driver.call("liquid_handler", "move_to_clean_wells");
    driver.write("liquid_handler", "mixing_cycles", 1);
    expect(experiment(driver, 10).error).toBe("E-217"); // the right recipe, but no human in the loop yet
    sim.setHumanInLoop(true);
    driver.call("liquid_handler", "move_to_clean_wells");
    expect(experiment(driver, 10).error).toBeUndefined();
    expect(sim.activeFault()).toBeNull();
  });
});
