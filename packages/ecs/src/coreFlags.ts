export const CoreFlags = {
  Dead: "dead",
  InAir: "inAir",
  OnGround: "onGround",
  TouchingNonFloor: "touchingNonFloor",
} as const;

export type CoreFlagName = typeof CoreFlags[keyof typeof CoreFlags];

export const CoreFlagCustomSources = {
  Touching: "Touching",
} as const;

export type CoreFlagCustomSourceName =
  typeof CoreFlagCustomSources[keyof typeof CoreFlagCustomSources];
