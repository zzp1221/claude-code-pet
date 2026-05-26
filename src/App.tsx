import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { normalizeState } from "./atlas";
import { PetCanvas } from "./PetCanvas";
import type { CompanionConfig, Language, PetInfo, PetState, RuntimeState } from "./types";

const DEFAULT_CONFIG: CompanionConfig = {
  activePetId: "hiyue",
  language: "zh-CN",
  petSources: [],
  window: {
    scale: 1,
    alwaysOnTop: true
  }
};

const COPY = {
  "zh-CN": {
    actions: {
      allow: "允许",
      closeMenu: "关闭菜单",
      closeNotice: "关闭提示",
      deny: "拒绝",
      disableTop: "取消置顶",
      enableTop: "保持置顶",
      importPet: "导入宠物文件夹",
      quit: "退出",
      resetPosition: "重置位置",
      scanCodex: "扫描 Codex 宠物"
    },
    aria: {
      dragPet: "拖动桌宠",
      menu: "宠物菜单"
    },
    fields: {
      language: "界面语言",
      pet: "宠物"
    },
    languageNames: {
      "zh-CN": "中文",
      en: "English"
    },
    messages: {
      codexSyncFailed: "扫描 Codex 宠物失败",
      codexSynced: (count: number) => `已同步 ${count} 个 Codex 宠物`,
      importTitle: "选择包含 pet.json 的宠物文件夹",
      noPet: "暂无宠物",
      petFallback: "Claude 桌宠"
    },
    notices: {
      approvalDetail: "可在这里确认，也可回到终端处理",
      failedBody: "Claude Code 遇到错误",
      failedTitle: "操作失败",
      permissionBody: "回到终端选择 Yes / No",
      permissionDetail: (toolName: string) => `来自 ${toolName}`,
      permissionTitle: "需要你的确认",
      reviewBody: "回到 Claude Code 查看结果",
      reviewTitle: "回复已完成",
      waitingBody: "回到 Claude Code 继续",
      waitingTitle: "Claude Code 正在等待"
    },
    states: {
      failed: "失败",
      idle: "空闲",
      jumping: "跳跃",
      review: "完成",
      running: "运行中",
      "running-left": "向左跑",
      "running-right": "向右跑",
      waiting: "等待",
      waving: "挥手"
    }
  },
  en: {
    actions: {
      allow: "Allow",
      closeMenu: "Close menu",
      closeNotice: "Close notice",
      deny: "Deny",
      disableTop: "Disable Always On Top",
      enableTop: "Enable Always On Top",
      importPet: "Import Pet Folder",
      quit: "Quit",
      resetPosition: "Reset Position",
      scanCodex: "Scan Codex Pets"
    },
    aria: {
      dragPet: "Drag pet",
      menu: "Pet menu"
    },
    fields: {
      language: "Language",
      pet: "Pet"
    },
    languageNames: {
      "zh-CN": "中文",
      en: "English"
    },
    messages: {
      codexSyncFailed: "Failed to scan Codex pets",
      codexSynced: (count: number) => `Synced ${count} Codex pet${count === 1 ? "" : "s"}`,
      importTitle: "Select a pet folder containing pet.json",
      noPet: "No pet",
      petFallback: "Claude Pet"
    },
    notices: {
      approvalDetail: "Confirm here, or return to the terminal",
      failedBody: "Claude Code hit an error",
      failedTitle: "Action failed",
      permissionBody: "Return to the terminal and choose Yes / No",
      permissionDetail: (toolName: string) => `From ${toolName}`,
      permissionTitle: "Needs your approval",
      reviewBody: "Return to Claude Code to review the result",
      reviewTitle: "Response ready",
      waitingBody: "Return to Claude Code to continue",
      waitingTitle: "Claude Code is waiting"
    },
    states: {
      failed: "failed",
      idle: "idle",
      jumping: "jumping",
      review: "review",
      running: "running",
      "running-left": "running-left",
      "running-right": "running-right",
      waiting: "waiting",
      waving: "waving"
    }
  }
} satisfies Record<Language, {
  actions: Record<"allow" | "closeMenu" | "closeNotice" | "deny" | "disableTop" | "enableTop" | "importPet" | "quit" | "resetPosition" | "scanCodex", string>;
  aria: Record<"dragPet" | "menu", string>;
  fields: Record<"language" | "pet", string>;
  languageNames: Record<Language, string>;
  messages: {
    codexSyncFailed: string;
    codexSynced: (count: number) => string;
    importTitle: string;
    noPet: string;
    petFallback: string;
  };
  notices: {
    approvalDetail: string;
    failedBody: string;
    failedTitle: string;
    permissionBody: string;
    permissionDetail: (toolName: string) => string;
    permissionTitle: string;
    reviewBody: string;
    reviewTitle: string;
    waitingBody: string;
    waitingTitle: string;
  };
  states: Record<PetState, string>;
}>;

function clampScale(value: number) {
  return Math.min(2.5, Math.max(0.5, Number(value.toFixed(2))));
}

function shortText(value: string | null | undefined, maxLength = 72) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function noticeFor(runtime: RuntimeState, state: PetState, copy: typeof COPY[Language]) {
  if (state === "waiting") {
    const isPermission =
      runtime.event === "permission-request" ||
      runtime.event === "exit-plan-mode" ||
      runtime.event.includes("permission") ||
      runtime.notificationType === "permission_prompt";

    return {
      tone: "waiting",
      title: isPermission ? copy.notices.permissionTitle : copy.notices.waitingTitle,
      body: shortText(runtime.message || runtime.toolInputSummary || runtime.detail, 180) || (isPermission ? copy.notices.permissionBody : copy.notices.waitingBody),
      detail: runtime.toolName ? copy.notices.permissionDetail(runtime.toolName) : ""
    };
  }

  if (state === "failed") {
    return {
      tone: "failed",
      title: copy.notices.failedTitle,
      body: shortText(runtime.error || runtime.reason) || copy.notices.failedBody,
      detail: ""
    };
  }

  if (state === "review") {
    return {
      tone: "review",
      title: copy.notices.reviewTitle,
      body: copy.notices.reviewBody,
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
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [dismissedNoticeAt, setDismissedNoticeAt] = useState("");
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
  const language = config.language === "en" ? "en" : "zh-CN";
  const copy = COPY[language];
  const notice = useMemo(() => noticeFor(runtime, activeState, copy), [activeState, copy, runtime]);
  const visibleNotice = notice && dismissedNoticeAt !== runtime.updatedAt ? notice : null;

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
        await invoke("install_app_copy").catch(() => undefined);
        await invoke<PetInfo[]>("sync_codex_pets").catch(() => []);
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
        await invoke("write_pet_heartbeat");
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
    const shouldRefreshPets =
      runtime.event === "pet-imported" ||
      runtime.event === "pet-switched" ||
      runtime.event === "codex-pets-synced";
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
      title: copy.messages.importTitle
    });
    if (typeof selected !== "string") return;
    try {
      const imported = await invoke<PetInfo>("import_pet", { sourceDir: selected });
      await refreshPets(imported.id);
      await saveConfig({ ...config, activePetId: imported.id });
      setError(null);
      setSyncMessage(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  async function syncCodexPets(showResult = true) {
    setIsSyncing(true);
    try {
      const synced = await invoke<PetInfo[]>("sync_codex_pets");
      await refreshPets(config.activePetId);
      setError(null);
      if (showResult) setSyncMessage(copy.messages.codexSynced(synced.length));
    } catch (syncError) {
      setError(`${copy.messages.codexSyncFailed}: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
    } finally {
      setIsSyncing(false);
    }
  }

  async function changeLanguage(nextLanguage: Language) {
    await saveConfig({
      ...config,
      language: nextLanguage
    });
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

  async function resetPosition() {
    await invoke("reset_window_position");
  }

  async function closeApp() {
    await invoke("close_app");
  }

  async function decideApproval(decision: "allow" | "deny") {
    if (!runtime.approvalId) return;
    await invoke("write_approval_decision", {
      approvalId: runtime.approvalId,
      decision
    });
    setRuntime((previous) => ({
      ...previous,
      approvalId: null,
      event: decision === "allow" ? "approval-allowed" : "approval-denied",
      requiresDecision: false,
      state: decision === "allow" ? "running" : "idle",
      updatedAt: `${Date.now()}`
    }));
    setDismissedNoticeAt(runtime.updatedAt);
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
      <button className="drag-layer" aria-label={copy.aria.dragPet} onMouseDown={(event) => void startDrag(event)} />
      <button className="menu-dot" aria-label={copy.aria.menu} onClick={() => setMenuOpen((openNow) => !openNow)}>
        <span />
      </button>

      <section className="pet-stage">
        <PetCanvas imageUrl={imageUrl} state={displayState} scale={config.window.scale} />
      </section>

      {visibleNotice && (
        <div className={`status-bubble ${visibleNotice.tone}`} role="status" aria-live="polite">
          <div className="bubble-head">
            <strong>{visibleNotice.title}</strong>
            <button onClick={() => setDismissedNoticeAt(runtime.updatedAt)} aria-label={copy.actions.closeNotice}>x</button>
          </div>
          <span>{visibleNotice.body}</span>
          {runtime.requiresDecision && <small>{copy.notices.approvalDetail}</small>}
          {visibleNotice.detail && <small>{visibleNotice.detail}</small>}
          {runtime.requiresDecision && runtime.approvalId && (
            <div className="approval-actions">
              <button onClick={() => void decideApproval("deny")}>{copy.actions.deny}</button>
              <button className="primary" onClick={() => void decideApproval("allow")}>{copy.actions.allow}</button>
            </div>
          )}
        </div>
      )}

      <div className="caption">
        <strong>{activePet?.displayName ?? copy.messages.petFallback}</strong>
        <span>{copy.states[displayState]}</span>
      </div>

      {menuOpen && (
        <aside className="panel">
          <div className="panel-head">
            <div>
              <strong>{activePet?.displayName ?? copy.messages.noPet}</strong>
              <span>{runtime.event || "Claude Code"}</span>
            </div>
            <button onClick={() => setMenuOpen(false)} aria-label={copy.actions.closeMenu}>x</button>
          </div>

          <label className="field">
            {copy.fields.language}
            <select value={language} onChange={(event) => void changeLanguage(event.target.value as Language)}>
              <option value="zh-CN">{copy.languageNames["zh-CN"]}</option>
              <option value="en">{copy.languageNames.en}</option>
            </select>
          </label>

          <label className="field">
            {copy.fields.pet}
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

          <button className="wide" onClick={() => void syncCodexPets()} disabled={isSyncing}>{copy.actions.scanCodex}</button>
          <button className="wide" onClick={() => void importPet()}>{copy.actions.importPet}</button>
          <button className="wide" onClick={() => void toggleAlwaysOnTop()}>
            {config.window.alwaysOnTop ? copy.actions.disableTop : copy.actions.enableTop}
          </button>
          <button className="wide" onClick={() => void resetPosition()}>{copy.actions.resetPosition}</button>

          {syncMessage && <p className="success">{syncMessage}</p>}
          {error && <p className="error">{error}</p>}
          <div className="panel-footer">
            <button className="wide danger" onClick={() => void closeApp()}>{copy.actions.quit}</button>
          </div>
        </aside>
      )}
    </main>
  );
}
