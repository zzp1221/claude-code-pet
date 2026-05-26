import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { normalizeState } from "./atlas";
import { PetCanvas } from "./PetCanvas";
import type { CompanionConfig, PetInfo, PetState, RuntimeState } from "./types";

const DEFAULT_CONFIG: CompanionConfig = {
  activePetId: "hiyue",
  petSources: [],
  window: {
    scale: 1,
    alwaysOnTop: true
  }
};

function clampScale(value: number) {
  return Math.min(2.5, Math.max(0.5, Number(value.toFixed(2))));
}

function shortText(value: string | null | undefined, maxLength = 72) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function noticeFor(runtime: RuntimeState, state: PetState) {
  if (state === "waiting") {
    const isPermission =
      runtime.event === "permission-request" ||
      runtime.event === "exit-plan-mode" ||
      runtime.event.includes("permission") ||
      runtime.notificationType === "permission_prompt";

    return {
      tone: "waiting",
      title: isPermission ? "Needs your approval" : "Claude Code is waiting",
      body: shortText(runtime.message) || (isPermission ? "Return to the terminal and choose Yes / No" : "Return to Claude Code to continue"),
      detail: runtime.toolName ? `From ${runtime.toolName}` : ""
    };
  }

  if (state === "failed") {
    return {
      tone: "failed",
      title: "Action failed",
      body: shortText(runtime.error || runtime.reason) || "Claude Code hit an error",
      detail: ""
    };
  }

  if (state === "review") {
    return {
      tone: "review",
      title: "Response ready",
      body: "Return to Claude Code to review the result",
      detail: ""
    };
  }

  return null;
}

function randomIdleDelay() {
  return 9000 + Math.round(Math.random() * 9000);
}

export default function App() {
  const [config, setConfig] = useState<CompanionConfig>(DEFAULT_CONFIG);
  const [pets, setPets] = useState<PetInfo[]>([]);
  const [activePet, setActivePet] = useState<PetInfo | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState>({
    state: "idle",
    event: "initial",
    updatedAt: "",
    ttlMs: 0
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sequenceState, setSequenceState] = useState<PetState | null>(null);
  const [idleFlourish, setIdleFlourish] = useState<PetState | null>(null);
  const [dragState, setDragState] = useState<PetState | null>(null);
  const lastRuntimeUpdate = useRef("");
  const sequenceTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const idleResetTimer = useRef<number | null>(null);
  const dragTimer = useRef<number | null>(null);

  const activeState = useMemo<PetState>(() => normalizeState(runtime.state), [runtime.state]);
  const displayState = dragState ?? sequenceState ?? idleFlourish ?? activeState;
  const notice = useMemo(() => noticeFor(runtime, activeState), [activeState, runtime]);

  const refreshPets = useCallback(async (activeId?: string) => {
    const found = await invoke<PetInfo[]>("list_pets");
    setPets(found);
    const next = found.find((pet) => pet.id === (activeId ?? config.activePetId)) ?? found[0] ?? null;
    setActivePet(next);
    if (next) {
      const dataUrl = await invoke<string>("load_image_data_url", { path: next.spritesheetPath });
      setImageUrl(dataUrl);
    }
  }, [config.activePetId]);

  const saveConfig = useCallback(async (nextConfig: CompanionConfig) => {
    setConfig(nextConfig);
    await invoke("save_config", { config: nextConfig });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const loaded = await invoke<CompanionConfig>("get_config");
        if (cancelled) return;
        setConfig(loaded);
        await refreshPets(loaded.activePetId);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshPets]);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const next = await invoke<RuntimeState>("read_state");
        setRuntime((previous) => {
          if (previous.updatedAt === next.updatedAt && previous.state === next.state) {
            return previous;
          }
          return next;
        });
      } catch {
        setRuntime((previous) => ({ ...previous, state: "idle" }));
      }
    }, 350);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const shouldRefreshPets = runtime.event === "pet-imported" || runtime.event === "pet-switched";
    if (!runtime.updatedAt || !shouldRefreshPets) return;

    let cancelled = false;
    async function refreshFromConfig() {
      try {
        const loaded = await invoke<CompanionConfig>("get_config");
        if (cancelled) return;
        setConfig(loaded);
        await refreshPets(runtime.petId ?? loaded.activePetId);
      } catch (refreshError) {
        if (!cancelled) setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
    }

    void refreshFromConfig();
    return () => {
      cancelled = true;
    };
  }, [refreshPets, runtime.event, runtime.petId, runtime.updatedAt]);

  useEffect(() => {
    return () => {
      for (const timer of [sequenceTimer.current, idleTimer.current, idleResetTimer.current, dragTimer.current]) {
        if (timer !== null) window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!runtime.updatedAt || runtime.updatedAt === lastRuntimeUpdate.current) return;
    lastRuntimeUpdate.current = runtime.updatedAt;
    if (sequenceTimer.current !== null) window.clearTimeout(sequenceTimer.current);
    setSequenceState(null);

    const event = runtime.event || "";
    if (activeState === "running" && event === "user-prompt") {
      setSequenceState("waving");
      sequenceTimer.current = window.setTimeout(() => setSequenceState(null), 900);
      return;
    }

    if (event.includes("slash-command") || event.includes("launch")) {
      setSequenceState("waving");
      sequenceTimer.current = window.setTimeout(() => setSequenceState(null), 2400);
      return;
    }

    if (activeState === "review") {
      setSequenceState("jumping");
      sequenceTimer.current = window.setTimeout(() => setSequenceState(null), 700);
    }
  }, [activeState, runtime.event, runtime.updatedAt]);

  useEffect(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    if (idleResetTimer.current !== null) window.clearTimeout(idleResetTimer.current);
    setIdleFlourish(null);

    if (activeState !== "idle" || sequenceState || dragState || menuOpen) return;

    idleTimer.current = window.setTimeout(() => {
      setIdleFlourish(Math.random() > 0.55 ? "waving" : "jumping");
      idleResetTimer.current = window.setTimeout(() => setIdleFlourish(null), 1100);
    }, randomIdleDelay());
  }, [activeState, sequenceState, dragState, menuOpen, runtime.updatedAt]);

  async function choosePet(id: string) {
    const pet = pets.find((candidate) => candidate.id === id);
    if (!pet) return;
    const nextConfig = { ...config, activePetId: id };
    await saveConfig(nextConfig);
    setActivePet(pet);
    setImageUrl(await invoke<string>("load_image_data_url", { path: pet.spritesheetPath }));
  }

  async function importPet() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select a pet folder containing pet.json"
    });
    if (typeof selected !== "string") return;
    try {
      const imported = await invoke<PetInfo>("import_pet", { sourceDir: selected });
      await refreshPets(imported.id);
      await saveConfig({ ...config, activePetId: imported.id });
      setError(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  async function adjustScale(delta: number) {
    await saveConfig({
      ...config,
      window: {
        ...config.window,
        scale: clampScale(config.window.scale + delta)
      }
    });
  }

  async function toggleAlwaysOnTop() {
    await saveConfig({
      ...config,
      window: {
        ...config.window,
        alwaysOnTop: !config.window.alwaysOnTop
      }
    });
  }

  async function closeApp() {
    await invoke("close_app");
  }

  async function startDrag(event: MouseEvent<HTMLButtonElement>) {
    if (menuOpen) return;
    if (dragTimer.current !== null) window.clearTimeout(dragTimer.current);
    setDragState(event.clientX < window.innerWidth / 2 ? "running-left" : "running-right");
    dragTimer.current = window.setTimeout(() => setDragState(null), 1000);
    await invoke("start_window_drag");
  }

  return (
    <main className="shell" onContextMenu={(event) => {
      event.preventDefault();
      setMenuOpen((openNow) => !openNow);
    }}>
      <button className="drag-layer" aria-label="Drag pet" onMouseDown={(event) => void startDrag(event)} />
      <button className="menu-dot" aria-label="Pet menu" onClick={() => setMenuOpen((openNow) => !openNow)}>
        <span />
      </button>

      <section className="pet-stage">
        <PetCanvas imageUrl={imageUrl} state={displayState} scale={config.window.scale} />
      </section>

      {notice && (
        <div className={`status-bubble ${notice.tone}`} role="status" aria-live="polite">
          <strong>{notice.title}</strong>
          <span>{notice.body}</span>
          {notice.detail && <small>{notice.detail}</small>}
        </div>
      )}

      <div className="caption">
        <strong>{activePet?.displayName ?? "Claude Pet"}</strong>
        <span>{displayState}</span>
      </div>

      {menuOpen && (
        <aside className="panel">
          <div className="panel-head">
            <div>
              <strong>{activePet?.displayName ?? "No pet"}</strong>
              <span>{runtime.event || "Claude Code"}</span>
            </div>
            <button onClick={() => setMenuOpen(false)} aria-label="Close menu">x</button>
          </div>

          <label className="field">
            Pet
            <select value={activePet?.id ?? ""} onChange={(event) => void choosePet(event.target.value)}>
              {pets.map((pet) => (
                <option key={pet.id} value={pet.id}>{pet.displayName}</option>
              ))}
            </select>
          </label>

          <div className="controls">
            <button onClick={() => void adjustScale(-0.1)}>-</button>
            <span>{Math.round(config.window.scale * 100)}%</span>
            <button onClick={() => void adjustScale(0.1)}>+</button>
          </div>

          <button className="wide" onClick={() => void importPet()}>Import Pet Folder</button>
          <button className="wide" onClick={() => void toggleAlwaysOnTop()}>
            {config.window.alwaysOnTop ? "Disable Always On Top" : "Enable Always On Top"}
          </button>
          <button className="wide danger" onClick={() => void closeApp()}>Quit</button>

          {error && <p className="error">{error}</p>}
        </aside>
      )}
    </main>
  );
}
