/** Scoring of plate reader results. A perfect transfer reads 1.000 in every well. */

const EXPECTED_READING = 1.0;

/** Root mean square error of the readings against the expected value. */
export function rmseOf(readings: number[]): number {
  const squares = readings.map((r) => (r - EXPECTED_READING) ** 2);
  const mean = squares.reduce((a, b) => a + b, 0) / readings.length;
  return Math.round(Math.sqrt(mean) * 10000) / 10000;
}

/** Average delivered fraction. Well below 1.0 means the tip is under-delivering. */
export function meanDeliveredOf(readings: number[]): number {
  const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
  return Math.round(mean * 1000) / 1000;
}
