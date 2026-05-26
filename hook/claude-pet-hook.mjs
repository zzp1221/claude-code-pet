#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const VALID_STATES = new Set([
  "idle",
  "running",
  "running-right",
  "running-left",
  "waiting",
  "failed",
  "review",
  "waving",
  "jumping"
]);

const EVENT_DEFAULTS = {
  SessionStart: ["idle", "session-start", 0],
  SessionEnd: ["idle", "session-end", 0],
  UserPromptSubmit: ["running", "user-prompt", 0],
  UserPromptExpansion: ["running", "user-prompt-expansion", 0],
  PreToolUse: ["running", "pre-tool-use", 0],
  PermissionRequest: ["waiting", "permission-request", 0],
  PostToolUse: ["running", "post-tool-use", 0],
  PostToolUseFailure: ["failed", "post-tool-use-failure", 3000],
  PostToolBatch: ["running", "post-tool-batch", 0],
  PermissionDenied: ["failed", "permission-denied", 3000],
  Notification: ["waiting", "notification", 0],
  SubagentStart: ["running", "subagent-start", 0],
  SubagentStop: ["review", "subagent-stop", 3000],
  TaskCreated: ["running", "task-created", 0],
  TaskCompleted: ["review", "task-completed", 3000],
  Stop: ["review", "stop", 3000],
  StopFailure: ["failed", "stop-failure", 3000],
  Elicitation: ["waiting", "elicitation", 0],
  ElicitationResult: ["running", "elicitation-result", 0],
  TeammateIdle: ["waiting", "teammate-idle", 0]
};

const WAITING_NOTIFICATION_TYPES = new Set([
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog"
]);

const IDLE_NOTIFICATION_TYPES = new Set([
  "auth_success",
  "elicitation_complete",
  "elicitation_response"
]);

function companionDir() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error("Missing user home directory");
  return join(home, ".claude", "pet-companion");
}

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const result = {
    state: null,
    event: null,
    ttlMs: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state") result.state = argv[++index] || result.state;
    if (arg === "--event") result.event = argv[++index] || result.event;
    if (arg === "--ttl-ms") result.ttlMs = Number(argv[++index] || result.ttlMs);
  }
  if (result.state && !VALID_STATES.has(result.state)) result.state = null;
  if (result.ttlMs !== null && (!Number.isFinite(result.ttlMs) || result.ttlMs < 0)) result.ttlMs = null;
  return result;
}

async function readStdinJson() {
  if (process.stdin.isTTY) return null;
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  if (!input.trim()) return null;
  try {
    return JSON.parse(input);
  } catch {
    return { raw: input.slice(0, 2000) };
  }
}

function hookEventName(input) {
  return input?.hook_event_name ?? input?.hookEventName ?? input?.event ?? null;
}

function trimText(value, maxLength) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function inferState(input) {
  const eventName = hookEventName(input);
  if (!eventName) return ["idle", "unknown", 0];

  if (eventName === "Notification") {
    const type = input?.notification_type ?? "unknown";
    if (WAITING_NOTIFICATION_TYPES.has(type)) return ["waiting", `notification:${type}`, 0];
    if (IDLE_NOTIFICATION_TYPES.has(type)) return ["idle", `notification:${type}`, 0];
    return ["waiting", `notification:${type}`, 0];
  }

  if (eventName === "PreToolUse") {
    if (input?.tool_name === "AskUserQuestion") return ["waiting", "ask-user-question", 0];
    if (input?.tool_name === "ExitPlanMode") return ["waiting", "exit-plan-mode", 0];
  }

  return EVENT_DEFAULTS[eventName] ?? ["idle", eventName, 0];
}

function resolvePayload(args, input) {
  const [inferredState, inferredEvent, inferredTtlMs] = inferState(input);
  const eventName = hookEventName(input);
  let state = args.state ?? inferredState;
  let event = args.event ?? inferredEvent;
  let ttlMs = args.ttlMs ?? inferredTtlMs;

  if (eventName === "Notification") {
    const [notificationState, notificationEvent, notificationTtlMs] = inferState(input);
    state = notificationState;
    event = notificationEvent;
    if (args.ttlMs === null) ttlMs = notificationTtlMs;
  }

  if (eventName === "PreToolUse" && (input?.tool_name === "AskUserQuestion" || input?.tool_name === "ExitPlanMode")) {
    const [questionState, questionEvent, questionTtlMs] = inferState(input);
    state = questionState;
    event = questionEvent;
    if (args.ttlMs === null) ttlMs = questionTtlMs;
  }

  if (!VALID_STATES.has(state)) state = "idle";
  if (!Number.isFinite(ttlMs) || ttlMs < 0) ttlMs = 0;

  return { state, event, ttlMs };
}

async function readCurrentState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

function isFreshWaitingState(current) {
  if (current?.state !== "waiting" || typeof current.updatedAt !== "string") return false;
  const updatedAt = Date.parse(current.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < 120000;
}

function shouldPreserveCurrentState(current, next) {
  return next.state === "running" && next.event === "pre-tool-use" && isFreshWaitingState(current);
}

function stateDetails(input) {
  return {
    hookEventName: hookEventName(input),
    toolName: input?.tool_name ?? input?.toolName ?? null,
    toolUseId: input?.tool_use_id ?? input?.toolUseId ?? null,
    notificationType: input?.notification_type ?? null,
    permissionMode: input?.permission_mode ?? null,
    title: trimText(input?.title, 160),
    message: trimText(input?.message, 240),
    reason: trimText(input?.reason, 240),
    error: trimText(input?.error, 240),
    sessionId: input?.session_id ?? input?.sessionId ?? null
  };
}

async function appendHookEvent(payload) {
  const logPath = join(companionDir(), "runtime", "hook-events.jsonl");
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function writeState(payload) {
  const statePath = join(companionDir(), "runtime", "state.json");
  await mkdir(dirname(statePath), { recursive: true });
  const current = await readCurrentState(statePath);
  if (shouldPreserveCurrentState(current, payload)) {
    await appendHookEvent({
      updatedAt: nowIso(),
      skipped: true,
      reason: "preserve-fresh-waiting-state",
      attemptedState: payload.state,
      attemptedEvent: payload.event,
      currentState: current.state,
      currentEvent: current.event
    }).catch(() => {});
    return false;
  }
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
  return true;
}

async function scheduleIdle(ttlMs, expectedUpdatedAt) {
  if (!ttlMs) return;
  const statePath = join(companionDir(), "runtime", "state.json");
  const helper = [
    "const fs=require('fs');",
    `setTimeout(()=>{`,
    `let current={};try{current=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'))}catch{}`,
    `if(current.updatedAt===${JSON.stringify(expectedUpdatedAt)}){`,
    `fs.mkdirSync(require('path').dirname(${JSON.stringify(statePath)}),{recursive:true});`,
    `fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({state:'idle',event:'ttl-expired',updatedAt:new Date().toISOString(),ttlMs:0,source:'claude-code-hook'}, null, 2)+'\\n')`,
    `}},${ttlMs});`
  ].join("");

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stdin = await readStdinJson();
  const resolved = resolvePayload(args, stdin);
  const updatedAt = nowIso();
  const payload = {
    state: resolved.state,
    event: resolved.event,
    updatedAt,
    ttlMs: resolved.ttlMs,
    source: "claude-code-hook",
    ...stateDetails(stdin)
  };
  const changed = await writeState(payload);
  await appendHookEvent({ ...payload, changed }).catch(() => {});
  await scheduleIdle(resolved.ttlMs, updatedAt);
}

main().catch(async (error) => {
  try {
    await writeState({
      state: "failed",
      event: "hook-error",
      updatedAt: nowIso(),
      ttlMs: 3000,
      source: "claude-code-hook",
      error: String(error?.message || error)
    });
  } catch {
    // Hooks should never block Claude Code for logging failures.
  }
});
