#!/usr/bin/env node
// Exercises the hook installer against throwaway home directories so the
// guarantees it makes about backups, reinstalls and pruning stay honest.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("./install-hooks.mjs", import.meta.url));

async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), "pet-home-"));
  await mkdir(join(dir, ".claude"), { recursive: true });
  return dir;
}

async function invoke(home, extraEnv = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [installer], {
      env: { ...process.env, ...extraEnv, USERPROFILE: home, HOME: home }
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function textOf(hook) {
  const args = Array.isArray(hook?.args) ? hook.args.join(" ") : "";
  return `${hook?.command ?? ""} ${args}`;
}

const results = [];

// A fresh install writes 19 events and creates no backup, because there is
// nothing to back up yet.
{
  const home = await freshHome();
  const result = await invoke(home);
  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const events = Object.keys(settings.hooks ?? {}).length;
  const backups = await readdir(join(home, ".claude", "backups")).catch(() => []);
  results.push([
    "fresh install",
    result.code === 0 && events === 19 && backups.length === 0,
    `code=${result.code} events=${events} backups=${backups.length}`
  ]);
}

// A settings.json that no longer parses must fail with an actionable message
// and still leave the original bytes in the backup directory.
{
  const home = await freshHome();
  const path = join(home, ".claude", "settings.json");
  const original = '{ "hooks": { broken';
  await writeFile(path, original, "utf8");
  const result = await invoke(home);
  const backups = await readdir(join(home, ".claude", "backups")).catch(() => []);
  const helpful = result.out.includes("backup copy was written");
  results.push([
    "corrupt settings fails with a hint",
    result.code !== 0 && backups.length === 1 && helpful,
    `code=${result.code} backups=${backups.length} hint=${helpful}`
  ]);
  const restored = backups.length
    ? await readFile(join(home, ".claude", "backups", backups[0]), "utf8")
    : "";
  results.push(["corrupt settings is preserved", restored === original, `bytes=${restored.length}`]);
}

// Reinstalling replaces the pet hook in place and keeps a user hook that shares
// the same matcher.
{
  const home = await freshHome();
  const path = join(home, ".claude", "settings.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "node /elsewhere/claude-pet-hook.mjs", args: ["--state", "running"] },
                { type: "command", command: "echo user-hook", async: true }
              ]
            }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );
  const result = await invoke(home);
  const settings = JSON.parse(await readFile(path, "utf8"));
  const flat = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks ?? [entry]);
  const petHooks = flat.filter((hook) => textOf(hook).includes("claude-pet")).length;
  const userHookKept = flat.some((hook) => textOf(hook).includes("echo user-hook"));
  results.push([
    "reinstall keeps the user hook",
    result.code === 0 && petHooks === 1 && userHookKept,
    `code=${result.code} petHooks=${petHooks} userHookKept=${userHookKept}`
  ]);
}

// Repeated installs must not grow the backup directory without bound.
{
  const home = await freshHome();
  await writeFile(join(home, ".claude", "settings.json"), "{}\n", "utf8");
  for (let index = 0; index < 8; index += 1) await invoke(home);
  const backups = (await readdir(join(home, ".claude", "backups"))).filter((name) =>
    name.endsWith(".json")
  );
  results.push(["backups are pruned", backups.length === 5, `kept=${backups.length}`]);
}

// A bare hook entry (no hooks array) must survive, and an entry made purely of
// pet hooks must be removed rather than kept alongside the new one.
{
  const home = await freshHome();
  const path = join(home, ".claude", "settings.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { type: "command", command: "echo bare-user-hook" },
            { matcher: "", hooks: [{ type: "command", command: "node /elsewhere/claude-pet-hook.mjs" }] }
          ]
        }
      },
      null,
      2
    ),
    "utf8"
  );
  const result = await invoke(home);
  const settings = JSON.parse(await readFile(path, "utf8"));
  const entries = settings.hooks.PreToolUse;
  const flat = entries.flatMap((entry) => entry.hooks ?? [entry]);
  const bareKept = flat.some((hook) => textOf(hook).includes("echo bare-user-hook"));
  const petEntries = entries.filter(
    (entry) => Array.isArray(entry.hooks) && entry.hooks.every((hook) => textOf(hook).includes("claude-pet"))
  );
  results.push([
    "bare hook survives, all-pet entry replaced",
    result.code === 0 && bareKept && petEntries.length === 1,
    `code=${result.code} bareKept=${bareKept} petEntries=${petEntries.length}`
  ]);
}

// A negative PET_BACKUP_KEEP used to wipe every backup, including the one
// written moments before. It must fall back to the default instead.
{
  const home = await freshHome();
  await writeFile(join(home, ".claude", "settings.json"), "{}\n", "utf8");
  for (let index = 0; index < 3; index += 1) await invoke(home);
  const before = (await readdir(join(home, ".claude", "backups"))).filter((name) =>
    name.endsWith(".json")
  ).length;
  await invoke(home, { PET_BACKUP_KEEP: "-1" });
  const after = (await readdir(join(home, ".claude", "backups"))).filter((name) =>
    name.endsWith(".json")
  ).length;
  results.push([
    "negative PET_BACKUP_KEEP keeps backups",
    before === 3 && after >= 4,
    `before=${before} after=${after}`
  ]);
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}
console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
