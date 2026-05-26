export type PetState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type RuntimeState = {
  state: PetState | string;
  event: string;
  updatedAt: string;
  ttlMs: number;
};

export type WindowConfig = {
  x?: number | null;
  y?: number | null;
  scale: number;
  alwaysOnTop: boolean;
};

export type CompanionConfig = {
  activePetId: string;
  petSources: string[];
  window: WindowConfig;
};

export type PetInfo = {
  id: string;
  displayName: string;
  description?: string;
  dir: string;
  spritesheetPath: string;
};
