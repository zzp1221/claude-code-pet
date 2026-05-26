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

export function normalizeState(state: string | undefined): PetState {
  if (!state) return "idle";
  if (state in rowByState) return state as PetState;
  if (state === "permission" || state === "notification") return "waiting";
  if (state === "error" || state === "denied") return "failed";
  if (state === "done" || state === "stop") return "review";
  return "idle";
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
