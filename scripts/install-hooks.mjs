#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
if (!home) throw new Error("Missing user home directory");

const claudeDir = join(home, ".claude");
const companionDir = join(claudeDir, "pet-companion");
const settingsPath = join(claudeDir, "settings.json");
const backupDir = join(claudeDir, "backups");
const hookScript = join(companionDir, "hook", "claude-pet-hook.mjs");
const stableExe = join(companionDir, "bin", "claude-pet-companion.exe");
const releaseExe = join(process.cwd(), "src-tauri", "target", "release", "claude-pet-companion.exe");
const nodeExe = process.execPath;

const EVENT_MAP = [
  ["SessionStart", "idle", "session-start", 0],
  ["SessionEnd", "idle", "session-end", 0],
  ["UserPromptSubmit", "running", "user-prompt", 0],
  ["UserPromptExpansion", "running", "user-prompt-expansion", 0],
  ["PreToolUse", "running", "pre-tool-use", 0],
  ["PostToolUse", "running", "post-tool-use", 0],
  ["PostToolBatch", "running", "post-tool-batch", 0],
  ["PermissionRequest", "waiting", "permission-request", 0],
  ["Notification", "waiting", "notification", 0],
  ["Elicitation", "waiting", "elicitation", 0],
  ["ElicitationResult", "running", "elicitation-result", 0],
  ["PostToolUseFailure", "failed", "post-tool-use-failure", 3000],
  ["PermissionDenied", "failed", "permission-denied", 3000],
  ["StopFailure", "failed", "stop-failure", 3000],
  ["SubagentStart", "running", "subagent-start", 0],
  ["Stop", "review", "stop", 3000],
  ["SubagentStop", "review", "subagent-stop", 3000],
  ["TaskCreated", "running", "task-created", 0],
  ["TaskCompleted", "review", "task-completed", 3000]
];

function argsFor(state, event, ttlMs) {
  const args = [hookScript, "--state", state, "--event", event];
  if (ttlMs) args.push("--ttl-ms", String(ttlMs));
  return args;
}

async function findHookExe() {
  try {
    await access(stableExe);
    return stableExe;
  } catch {}

  try {
    await access(releaseExe);
    await mkdir(join(companionDir, "bin"), { recursive: true });
    await copyFile(releaseExe, stableExe);
    return stableExe;
  } catch {
    return null;
  }
}

function commandHookFor(exePath, state, event, ttlMs) {
  const quoted = `"${exePath.replaceAll("\\", "/")}"`;
  let command = `${quoted} --hook --state ${state} --event ${event}`;
  if (ttlMs) command += ` --ttl-ms ${ttlMs}`;
  return command;
}

function normalizeEventHooks(settings, eventName) {
  settings.hooks ??= {};
  const current = settings.hooks[eventName];
  if (Array.isArray(current)) return current;
  if (!current) {
    settings.hooks[eventName] = [];
    return settings.hooks[eventName];
  }
  settings.hooks[eventName] = [current];
  return settings.hooks[eventName];
}

function withoutExistingPetHook(hooks) {
  return hooks.filter((entry) => {
    const hook = entry?.hooks?.[0] ?? entry;
    const command = hook?.command ?? "";
    const args = Array.isArray(hook?.args) ? hook.args.join(" ") : "";
    const text = `${command} ${args}`;
    return !text.includes("claude-pet-hook.mjs") && !text.includes("claude-pet-companion");
  });
}

async function main() {
  await mkdir(backupDir, { recursive: true });
  await mkdir(join(companionDir, "runtime"), { recursive: true });
  await mkdir(join(companionDir, "pets"), { recursive: true });

  const text = await readFile(settingsPath, "utf8").catch(() => "{}");
  const settings = JSON.parse(text || "{}");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(settingsPath, join(backupDir, `settings.pet-companion.${stamp}.json`)).catch(() => {});

  for (const [eventName, state, event, ttlMs] of EVENT_MAP) {
    const hooks = normalizeEventHooks(settings, eventName);
    const filtered = withoutExistingPetHook(hooks);
    const exePath = await findHookExe();
    filtered.push({
      matcher: "",
      hooks: [
        exePath
          ? {
              type: "command",
              command: commandHookFor(exePath, state, event, ttlMs),
              async: true,
              timeout: 5
            }
          : {
              type: "command",
              command: nodeExe,
              args: argsFor(state, event, ttlMs),
              async: true,
              timeout: 5
            }
      ]
    });
    settings.hooks[eventName] = filtered;
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await writeFile(
    join(companionDir, "runtime", "state.json"),
    `${JSON.stringify({ state: "idle", event: "installed", updatedAt: new Date().toISOString(), ttlMs: 0, source: "installer" }, null, 2)}\n`,
    "utf8"
  );

  console.log(`Installed Claude Pet Companion hooks for ${EVENT_MAP.length} events.`);
  console.log(`Backup written under ${backupDir}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
