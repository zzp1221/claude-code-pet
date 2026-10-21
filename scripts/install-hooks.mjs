#!/usr/bin/env node
import { access, copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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

const BACKUP_PREFIX = "settings.pet-companion.";
const DEFAULT_BACKUP_KEEP = 5;
// A negative or fractional value used to sail straight through: -3 removed every
// backup including the one written moments earlier, which is the exact copy this
// change exists to preserve. Keep at least one.
const parsedBackupKeep = Number(process.env.PET_BACKUP_KEEP);
const backupKeep =
  Number.isInteger(parsedBackupKeep) && parsedBackupKeep >= 1
    ? parsedBackupKeep
    : DEFAULT_BACKUP_KEEP;

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

function referencesPet(hook) {
  const command = hook?.command ?? "";
  const args = Array.isArray(hook?.args) ? hook.args.join(" ") : "";
  const text = `${command} ${args}`;
  return text.includes("claude-pet-hook.mjs") || text.includes("claude-pet-companion");
}

function withoutExistingPetHook(entries) {
  const result = [];
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) {
      if (!referencesPet(entry)) result.push(entry);
      continue;
    }
    // Strip only the pet entries so hooks the user added to the same matcher
    // survive a reinstall.
    const kept = entry.hooks.filter((hook) => !referencesPet(hook));
    if (kept.length === entry.hooks.length) {
      result.push(entry);
    } else if (kept.length > 0) {
      result.push({ ...entry, hooks: kept });
    }
  }
  return result;
}

async function readSettingsFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    // Never echo error.message. It is a V8 implementation detail that has
    // carried snippets of the offending input in other runtimes, and
    // settings.json legitimately holds tokens and hook commands.
    const position = Number.isInteger(error?.position) ? ` at position ${error.position}` : "";
    throw new Error(
      `Cannot parse ${path}${position}. ` +
        "A backup copy was written before parsing; restore it, fix the JSON, and run the installer again."
    );
  }
}

async function backupSettings(path, dir, stamp) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${BACKUP_PREFIX}${stamp}.json`);
  try {
    await copyFile(path, target);
    return target;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function pruneBackups(dir, limit) {
  const requested = Math.floor(Number(limit));
  const keep = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_BACKUP_KEEP;
  const entries = await readdir(dir).catch(() => []);
  const backups = entries
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(".json"))
    .sort();
  const stale = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of stale) {
    await unlink(join(dir, name)).catch(() => {});
  }
  return { removed: stale.length, kept: Math.min(backups.length, keep) };
}

async function main() {
  await mkdir(join(companionDir, "runtime"), { recursive: true });
  await mkdir(join(companionDir, "pets"), { recursive: true });

  // Back up before parsing: a hand-edited settings.json that no longer parses
  // must still leave the user a copy of what they had.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = await backupSettings(settingsPath, backupDir, stamp);
  const settings = await readSettingsFile(settingsPath);

  // Probing for the binary touches the filesystem twice per event; do it once.
  const exePath = await findHookExe();

  for (const [eventName, state, event, ttlMs] of EVENT_MAP) {
    const hooks = normalizeEventHooks(settings, eventName);
    const filtered = withoutExistingPetHook(hooks);
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

  const pruned = await pruneBackups(backupDir, backupKeep);

  console.log(`Installed Claude Pet Companion hooks for ${EVENT_MAP.length} events.`);
  if (backupPath) console.log(`Settings backup written to ${backupPath}.`);
  if (pruned.removed > 0) {
    console.log(`Removed ${pruned.removed} old backup(s); keeping the newest ${pruned.kept}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
