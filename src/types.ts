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
  error?: string | null;
  message?: string | null;
  notificationType?: string | null;
  petId?: string | null;
  reason?: string | null;
  toolName?: string | null;
};

export type WindowConfig = {
  x?: number | null;
  y?: number | null;
  scale: number;
  alwaysOnTop: boolean;
};

export type Language = "zh-CN" | "en";

export type CompanionConfig = {
  activePetId: string;
  language?: Language;
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
