import { expect, test } from "bun:test";
import { meanDeliveredOf, rmseOf } from "../src/shared/score";

test("a perfect plate has zero error and full delivery", () => {
  const readings = [1, 1, 1, 1, 1, 1, 1, 1];
  expect(rmseOf(readings)).toBe(0);
  expect(meanDeliveredOf(readings)).toBe(1);
});

test("alternating readings give an RMSE equal to their spread", () => {
  const readings = [1.1, 0.9, 1.1, 0.9, 1.1, 0.9, 1.1, 0.9];
  expect(rmseOf(readings)).toBeCloseTo(0.1, 4);
  expect(meanDeliveredOf(readings)).toBeCloseTo(1, 4);
});

test("a clogged tip shows up as a low mean delivered fraction", () => {
  const readings = [0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55];
  expect(meanDeliveredOf(readings)).toBe(0.55);
  expect(rmseOf(readings)).toBeCloseTo(0.45, 4);
});
