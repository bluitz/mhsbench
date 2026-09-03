import type { FluidCard, FluidId } from "./types";

/**
 * Public sample cards. These are safe to ship to the browser and to the agent:
 * they do not reveal the simulator's ideal flow rate.
 */
export const FLUID_CARDS: Record<FluidId, FluidCard> = {
  water: {
    id: "water",
    name: "Water",
    character: "Simple aqueous reagent",
    description:
      "Plain water with a tracking dye. Forgiving: a wide range of flow rates dispense accurately.",
    tolerance: 0.0176,
  },
  bsa: {
    id: "bsa",
    name: "BSA protein solution (10 mg/mL)",
    character: "Viscous, foamy protein sample",
    description:
      "Bovine serum albumin. Viscous and prone to foaming: dispensing too fast introduces air and under-delivers.",
    tolerance: 0.1991,
  },
};

export const FLUID_LIST: FluidCard[] = [FLUID_CARDS.water, FLUID_CARDS.bsa];
