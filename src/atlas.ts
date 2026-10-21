import type { PetState } from "./types";

export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;
export const ATLAS_COLUMNS = 8;

export const rowByState: Record<PetState, number> = {
  idle: 0,
  "running-right": 1,
  "running-left": 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8
};

export const frameCountByState: Record<PetState, number> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6
};

const STATE_ALIASES: Record<string, PetState> = {
  permission: "waiting",
  notification: "waiting",
  error: "failed",
  denied: "failed",
  done: "review",
  stop: "review"
};

const KNOWN_STATES = new Set(Object.keys(rowByState));

function isPetState(value: string): value is PetState {
  return KNOWN_STATES.has(value);
}

export function normalizeState(state: string | undefined): PetState {
  if (!state) return "idle";
  if (isPetState(state)) return state;
  return STATE_ALIASES[state] ?? "idle";
}

export function nextFrameDelay(state: PetState): number {
  switch (state) {
    case "running":
    case "running-right":
    case "running-left":
      return 95;
    case "failed":
      return 150;
    case "waiting":
      return 170;
    case "review":
      return 145;
    case "jumping":
      return 115;
    default:
      return 180;
  }
}
