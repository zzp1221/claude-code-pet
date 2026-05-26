#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.USERPROFILE || process.env.HOME;
if (!home) throw new Error("Missing user home directory");

const claudeDir = join(home, ".claude");
const settingsPath = join(claudeDir, "settings.json");
const backupDir = join(claudeDir, "backups");

function isPetHook(entry) {
  const hook = entry?.hooks?.[0] ?? entry;
  const command = hook?.command ?? "";
  const args = Array.isArray(hook?.args) ? hook.args.join(" ") : "";
  return `${command} ${args}`.includes("claude-pet-hook.mjs") || `${command} ${args}`.includes("claude-pet-companion");
}

async function main() {
  await mkdir(backupDir, { recursive: true });
  const text = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(text || "{}");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(settingsPath, join(backupDir, `settings.pet-companion-uninstall.${stamp}.json`));

  if (settings.hooks && typeof settings.hooks === "object") {
    for (const eventName of Object.keys(settings.hooks)) {
      const hooks = Array.isArray(settings.hooks[eventName])
        ? settings.hooks[eventName]
        : [settings.hooks[eventName]];
      const filtered = hooks.filter((entry) => !isPetHook(entry));
      if (filtered.length) {
        settings.hooks[eventName] = filtered;
      } else {
        delete settings.hooks[eventName];
      }
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  console.log("Removed Claude Pet Companion hooks.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
