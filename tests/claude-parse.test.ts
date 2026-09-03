import { describe, expect, test } from "bun:test";
import { parseProposal } from "../src/server/agents/claude";

describe("parseProposal", () => {
  test("reads a plain JSON experiment, with or without code fences", () => {
    const text = '{"kind":"experiment","flow_rate_uL_per_s":42.26,"mixing_cycles":1,"tip":"replace","wells":"clean","rationale":"because","diagnosis":"clog"}';
    const plain = parseProposal(text);
    expect(plain.flow_rate_uL_per_s).toBe(42.3); // rounded to one decimal
    expect(plain.tip).toBe("replace");
    expect(plain.wells).toBe("clean");
    expect(plain.diagnosis).toBe("clog");
    expect(parseProposal("```json\n" + text + "\n```")).toEqual(plain);
  });

  test("falls back to safe defaults for fields the model got wrong", () => {
    const p = parseProposal('{"kind":"experiment","flow_rate_uL_per_s":50,"mixing_cycles":2.5,"tip":"sideways","wells":"dirty"}');
    expect(p.mixing_cycles).toBe(3);
    expect(p.tip).toBe("keep");
    expect(p.wells).toBe("current");
    expect(p.rationale).toBe("");
    expect(p.diagnosis).toBeUndefined();
  });

  test("throws on a missing flow rate, an unknown kind, or non-JSON, so the loop retries", () => {
    expect(() => parseProposal('{"kind":"experiment","mixing_cycles":1}')).toThrow("missing flow_rate_uL_per_s");
    expect(() => parseProposal('{"kind":"conclude","best_flow_rate_uL_per_s":10}')).toThrow("Unknown proposal kind");
    expect(() => parseProposal("Sure! Here is my plan.")).toThrow();
  });
});
