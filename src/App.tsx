import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
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
      title: isPermission ? "需要你确认" : "Claude Code 在等你",
      body: shortText(runtime.message) || (isPermission ? "请回到终端选择 Yes / No" : "请回到 Claude Code 处理当前提示"),
      detail: runtime.toolName ? `来自 ${runtime.toolName}` : ""
    };
  }

  if (state === "failed") {
    return {
      tone: "failed",
      title: "执行失败",
      body: shortText(runtime.error || runtime.reason) || "Claude Code 遇到了错误",
      detail: ""
    };
  }

  if (state === "review") {
    return {
      tone: "review",
      title: "回复完成",
      body: "可以回到 Claude Code 查看结果",
      detail: ""
    };
  }

  return null;
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

  const activeState = useMemo<PetState>(() => normalizeState(runtime.state), [runtime.state]);
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

  async function startDrag() {
    if (menuOpen) return;
    await invoke("start_window_drag");
  }

  return (
    <main className="shell" onContextMenu={(event) => {
      event.preventDefault();
      setMenuOpen((openNow) => !openNow);
    }}>
      <button className="drag-layer" aria-label="Drag pet" onMouseDown={() => void startDrag()} />
      <button className="menu-dot" aria-label="Pet menu" onClick={() => setMenuOpen((openNow) => !openNow)}>
        <span />
      </button>

      <section className="pet-stage">
        <PetCanvas imageUrl={imageUrl} state={activeState} scale={config.window.scale} />
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
        <span>{activeState}</span>
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
