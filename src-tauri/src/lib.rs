use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const COMPANION_DIR: &str = ".claude/pet-companion";
const DEFAULT_WINDOW_X: i32 = 96;
const DEFAULT_WINDOW_Y: i32 = 96;
const HOOK_EVENTS: &[(&str, &str, &str, u64)] = &[
    ("SessionStart", "idle", "session-start", 0),
    ("SessionEnd", "idle", "session-end", 0),
    ("UserPromptSubmit", "running", "user-prompt", 0),
    ("UserPromptExpansion", "running", "user-prompt-expansion", 0),
    ("PreToolUse", "running", "pre-tool-use", 0),
    ("PostToolUse", "running", "post-tool-use", 0),
    ("PostToolBatch", "running", "post-tool-batch", 0),
    ("PermissionRequest", "waiting", "permission-request", 0),
    ("Notification", "waiting", "notification", 0),
    ("Elicitation", "waiting", "elicitation", 0),
    ("ElicitationResult", "running", "elicitation-result", 0),
    (
        "PostToolUseFailure",
        "failed",
        "post-tool-use-failure",
        3000,
    ),
    ("PermissionDenied", "failed", "permission-denied", 3000),
    ("StopFailure", "failed", "stop-failure", 3000),
    ("SubagentStart", "running", "subagent-start", 0),
    ("Stop", "review", "stop", 3000),
    ("SubagentStop", "review", "subagent-stop", 3000),
    ("TaskCreated", "running", "task-created", 0),
    ("TaskCompleted", "review", "task-completed", 3000),
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowConfig {
    x: Option<i32>,
    y: Option<i32>,
    scale: f64,
    always_on_top: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionConfig {
    active_pet_id: String,
    #[serde(default = "default_language")]
    language: String,
    pet_sources: Vec<String>,
    window: WindowConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: String,
    display_name: String,
    description: Option<String>,
    spritesheet_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetInfo {
    id: String,
    display_name: String,
    description: Option<String>,
    dir: String,
    spritesheet_path: String,
}

#[derive(Debug, Clone, Serialize)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the user home directory".to_string())
}

fn companion_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(COMPANION_DIR))
}

fn companion_pets_dir() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("pets"))
}

fn codex_pets_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".codex/pets"))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("config.json"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("runtime/state.json"))
}

fn approval_dir() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("runtime/approvals"))
}

fn approval_path(id: &str) -> Result<PathBuf, String> {
    Ok(approval_dir()?.join(format!("{id}.json")))
}

fn heartbeat_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("runtime/heartbeat.json"))
}

fn launcher_script_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("runtime/launch-pet.vbs"))
}

fn current_exe_path() -> Result<PathBuf, String> {
    env::current_exe().map_err(|error| error.to_string())
}

fn claude_settings_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude/settings.json"))
}

fn claude_commands_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude/commands"))
}

fn claude_skills_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude/skills"))
}

fn backup_path(label: &str) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(home_dir()?
        .join(".claude/backups")
        .join(format!("settings.pet-companion.{label}.{stamp}.json")))
}

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_config() -> Result<CompanionConfig, String> {
    let home = home_dir()?;
    let companion = companion_dir()?;
    Ok(CompanionConfig {
        active_pet_id: "hiyue".to_string(),
        language: default_language(),
        pet_sources: vec![
            home.join(".codex/pets").to_string_lossy().to_string(),
            companion.join("pets").to_string_lossy().to_string(),
        ],
        window: WindowConfig {
            x: None,
            y: None,
            scale: 1.0,
            always_on_top: true,
        },
    })
}

fn read_config_inner() -> Result<CompanionConfig, String> {
    let path = config_path()?;
    if !path.is_file() {
        let config = default_config()?;
        write_config_inner(&config)?;
        return Ok(config);
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let raw: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let config: CompanionConfig =
        serde_json::from_value(raw.clone()).map_err(|error| error.to_string())?;
    if raw.get("language").is_none() {
        write_config_inner(&config)?;
    }
    Ok(config)
}

fn write_config_inner(config: &CompanionConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

fn read_manifest(dir: &Path) -> Result<PetInfo, String> {
    let manifest_path = dir.join("pet.json");
    let text = fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: PetManifest = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let spritesheet = dir.join(&manifest.spritesheet_path);
    if !spritesheet.is_file() {
        return Err(format!("Missing spritesheet for pet {}", manifest.id));
    }
    Ok(PetInfo {
        id: manifest.id,
        display_name: manifest.display_name,
        description: manifest.description,
        dir: dir.to_string_lossy().to_string(),
        spritesheet_path: spritesheet.to_string_lossy().to_string(),
    })
}

fn list_pets_inner(config: &CompanionConfig) -> Vec<PetInfo> {
    let mut pets = Vec::new();
    for source in &config.pet_sources {
        let source_path = PathBuf::from(source);
        let Ok(entries) = fs::read_dir(source_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(pet) = read_manifest(&path) {
                    if !pets.iter().any(|known: &PetInfo| known.id == pet.id) {
                        pets.push(pet);
                    }
                }
            }
        }
    }
    pets.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    pets
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    if !path.is_file() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn compact_json(value: &Value, limit: usize) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| String::new()),
    };
    let text = text.replace('\n', " ").replace('\r', " ");
    if text.chars().count() > limit {
        format!("{}...", text.chars().take(limit).collect::<String>())
    } else {
        text
    }
}

fn tool_input_summary(input: Option<&Value>) -> Option<String> {
    let value = input?;
    for key in ["tool_input", "toolInput", "input", "parameters"] {
        if let Some(tool_input) = value.get(key) {
            if let Some(command) = tool_input.get("command").and_then(Value::as_str) {
                return Some(command.to_string());
            }
            if let Some(path) = tool_input
                .get("file_path")
                .or_else(|| tool_input.get("path"))
                .and_then(Value::as_str)
            {
                return Some(path.to_string());
            }
            return Some(compact_json(tool_input, 220));
        }
    }
    value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

fn backup_settings(label: &str) -> Result<(), String> {
    let settings = claude_settings_path()?;
    if !settings.is_file() {
        return Ok(());
    }
    let target = backup_path(label)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(settings, target).map_err(|error| error.to_string())?;
    Ok(())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn command_arg(path: &Path) -> String {
    format!("\"{}\"", path_text(path))
}

fn vb_string(value: &Path) -> String {
    value.to_string_lossy().replace('"', "\"\"")
}

fn install_launcher_script_inner() -> Result<PathBuf, String> {
    let script_path = launcher_script_path()?;
    let exe = current_exe_path()?;
    let state = state_path()?;
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let script = format!(
        r#"Option Explicit

Dim shell, fso, exePath, statePath, runtimeDir, payload, file
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

exePath = "{exe}"
statePath = "{state}"
runtimeDir = fso.GetParentFolderName(statePath)

If Not fso.FolderExists(runtimeDir) Then
  fso.CreateFolder runtimeDir
End If

payload = "{{""state"":""waving"",""event"":""slash-command"",""updatedAt"":""" & CStr(DateDiff("s", #1/1/1970#, Now())) & "000"",""ttlMs"":3000,""source"":""claude-pet-launcher""}}"
Set file = fso.CreateTextFile(statePath, True, False)
file.Write payload
file.Close

If Not fso.FileExists(exePath) Then
  MsgBox "Claude Pet Companion executable was not found:" & vbCrLf & exePath, vbExclamation, "Claude Pet Companion"
  WScript.Quit 1
End If

shell.Run Chr(34) & exePath & Chr(34) & " --launch --state waving --event slash-command --ttl-ms 3000", 1, False
"#,
        exe = vb_string(&exe),
        state = vb_string(&state)
    );
    fs::write(&script_path, script).map_err(|error| error.to_string())?;
    Ok(script_path)
}

fn hook_command_for(exe: &Path, state: &str, event: &str, ttl_ms: u64) -> String {
    let mut command = format!(
        "{} --hook --state {} --event {}",
        command_arg(exe),
        state,
        event
    );
    if ttl_ms > 0 {
        command.push_str(&format!(" --ttl-ms {ttl_ms}"));
    }
    command
}

fn is_pet_hook(entry: &Value) -> bool {
    let Some(hooks) = entry.get("hooks").and_then(Value::as_array) else {
        return false;
    };
    hooks.iter().any(|hook| {
        hook.get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command.contains("claude-pet-companion") || command.contains("claude-pet-hook.mjs")
            })
    })
}

fn hook_entry(exe: &Path, event_name: &str, state: &str, event: &str, ttl_ms: u64) -> Value {
    let waits_for_decision = event_name == "PreToolUse";
    json!({
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": hook_command_for(exe, state, event, ttl_ms),
                "timeout": if waits_for_decision { 130 } else { 5 },
                "async": !waits_for_decision
            }
        ]
    })
}

fn install_hooks_inner(announce: bool) -> Result<(), String> {
    let settings_path = claude_settings_path()?;
    backup_settings("install")?;
    let mut settings = read_json_file(&settings_path)?;
    if !settings.is_object() {
        settings = json!({});
    }
    if settings.get("hooks").and_then(Value::as_object).is_none() {
        settings["hooks"] = json!({});
    }
    let exe = current_exe_path()?;
    let hooks = settings
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Claude settings hooks must be an object".to_string())?;

    for (event_name, state, event, ttl_ms) in HOOK_EVENTS {
        let current = hooks.remove(*event_name).unwrap_or_else(|| json!([]));
        let mut entries = match current {
            Value::Array(items) => items,
            Value::Null => Vec::new(),
            other => vec![other],
        };
        entries.retain(|entry| !is_pet_hook(entry));
        entries.push(hook_entry(&exe, event_name, state, event, *ttl_ms));
        hooks.insert((*event_name).to_string(), Value::Array(entries));
    }

    write_json_file(&settings_path, &settings)?;
    if announce {
        write_state_inner("idle", "installed", 0, None)?;
    }
    install_pet_command_inner()?;
    install_pet_skill_inner()?;
    Ok(())
}

fn uninstall_hooks_inner() -> Result<(), String> {
    let settings_path = claude_settings_path()?;
    backup_settings("uninstall")?;
    let mut settings = read_json_file(&settings_path)?;
    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        let event_names: Vec<String> = hooks.keys().cloned().collect();
        for event_name in event_names {
            let current = hooks.remove(&event_name).unwrap_or_else(|| json!([]));
            let mut entries = match current {
                Value::Array(items) => items,
                Value::Null => Vec::new(),
                other => vec![other],
            };
            entries.retain(|entry| !is_pet_hook(entry));
            if !entries.is_empty() {
                hooks.insert(event_name, Value::Array(entries));
            }
        }
    }
    write_json_file(&settings_path, &settings)?;
    let command_path = claude_commands_dir()?.join("pet.md");
    if command_path.is_file() {
        let _ = fs::remove_file(command_path);
    }
    let skill_dir = claude_skills_dir()?.join("claude-pet-companion");
    if skill_dir.is_dir() {
        let _ = fs::remove_dir_all(skill_dir);
    }
    Ok(())
}

fn install_pet_command_inner() -> Result<(), String> {
    let command_dir = claude_commands_dir()?;
    fs::create_dir_all(&command_dir).map_err(|error| error.to_string())?;
    let exe = current_exe_path()?;
    let launcher = install_launcher_script_inner()?;
    let command = format!(
        r#"---
description: Launch/focus Claude Pet Companion, or create/import a recognizable desktop pet when arguments are provided.
argument-hint: [pet description | import <folder> | switch <pet-id> | sync]
allowed-tools: Bash(wscript.exe:*), Bash({}:*), Read, Write, Edit, MultiEdit, Glob, Grep, LS
---

!`wscript.exe {}`

Arguments: $ARGUMENTS

If `Arguments` is empty, tell the user that Claude Pet Companion has been launched.

If `Arguments` is not empty, treat it as a Claude Pet Companion request. Follow the installed skill at `~/.claude/skills/claude-pet-companion/SKILL.md`.

Common intents:
- `import <folder>`: validate the folder contains `pet.json` and `spritesheet.webp`, then run `{exe} --import-pet "<folder>"`.
- `switch <pet-id>`: run `{exe} --set-pet <pet-id>`, then run `wscript.exe {launcher}`.
- `sync` or `scan codex`: run `{exe} --sync-codex-pets` so pets installed in Codex become selectable here.
- Any mascot or character description: create a Codex-compatible pet package that this companion can recognize, then import it with `{exe} --import-pet "<package-folder>"`.
"#,
        path_text(&exe),
        command_arg(&launcher),
        exe = command_arg(&exe),
        launcher = command_arg(&launcher)
    );
    fs::write(command_dir.join("pet.md"), command).map_err(|error| error.to_string())?;
    install_pet_skill_inner()?;
    Ok(())
}

fn install_pet_skill_inner() -> Result<(), String> {
    let skill_dir = claude_skills_dir()?.join("claude-pet-companion");
    fs::create_dir_all(&skill_dir).map_err(|error| error.to_string())?;
    let exe = current_exe_path()?;
    let launcher = install_launcher_script_inner()?;
    let skill = format!(
        r#"---
name: claude-pet-companion
description: Create, validate, import, switch, and manage Claude Pet Companion desktop pets. Use when the user invokes /pet with a description, asks to make a recognizable desktop pet, imports a Codex-compatible pet package, or wants Claude Code to control the pet companion.
---

# Claude Pet Companion Skill

Use this skill when `/pet` includes arguments or when the user asks Claude Code to create, import, switch, or manage a desktop pet for Claude Pet Companion.

## Companion CLI

Use the installed executable:

```powershell
{exe}
```

Useful commands:

```powershell
{exe} --launch --state waving --event slash-command --ttl-ms 3000
{exe} --import-pet "<absolute pet package folder>"
{exe} --set-pet <pet-id>
wscript.exe {launcher}
{exe} --sync-codex-pets
```

## Recognizable Pet Package Contract

A package is recognized by the companion when it is a folder containing:

```text
pet.json
spritesheet.webp
```

`pet.json` must contain:

```json
{{
  "id": "lowercase-id",
  "displayName": "Display Name",
  "description": "Short description",
  "spritesheetPath": "spritesheet.webp"
}}
```

The spritesheet must be `1536x1872`, arranged as 8 columns x 9 rows, with `192x208` cells.

Rows:
0. `idle`
1. `running-right`
2. `running-left`
3. `waving`
4. `jumping`
5. `failed`
6. `waiting`
7. `running`
8. `review`

## Workflow For `/pet <description>`

1. Treat the arguments as the pet concept unless they clearly request `import` or `switch`.
2. Choose a short lowercase `id`, a display name, and a one-sentence description.
3. Create or obtain a complete 8x9 `spritesheet.webp` for all supported states.
4. Write `pet.json` next to the spritesheet.
5. Validate that both files exist and that the manifest points to `spritesheet.webp`.
6. Run `{exe} --import-pet "<package-folder>"`.
7. Tell the user the pet is installed and can be selected from the companion menu.

If image generation is not available in the current Claude Code environment, ask the user for an existing spritesheet or reference package instead of fabricating one.

## Workflow For `/pet import <folder>`

1. Resolve the folder path.
2. Confirm `pet.json` and its referenced spritesheet exist.
3. Run `{exe} --import-pet "<folder>"`.
4. Report the imported pet id and display name.

## Workflow For `/pet switch <pet-id>`

Run:

```powershell
{exe} --set-pet <pet-id>
wscript.exe {launcher}
```

If the pet id is unknown, inspect `~/.codex/pets` and `~/.claude/pet-companion/pets`.

## Workflow For `/pet sync` Or `/pet scan codex`

Run:

```powershell
{exe} --sync-codex-pets
```

Then tell the user that Codex-installed pets have been scanned and can be selected from the companion menu.
"#,
        exe = command_arg(&exe),
        launcher = command_arg(&launcher)
    );
    fs::write(skill_dir.join("SKILL.md"), skill).map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_user_installation() -> Result<(), String> {
    let _ = read_config_inner()?;
    install_hooks_inner(false)
}

fn now_iso_like() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("{millis}")
}

fn write_state_inner(
    state: &str,
    event: &str,
    ttl_ms: u64,
    extra: Option<Value>,
) -> Result<(), String> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut payload = json!({
        "state": state,
        "event": event,
        "updatedAt": now_iso_like(),
        "ttlMs": ttl_ms,
        "source": "claude-pet-companion-exe"
    });
    if let (Some(object), Some(extra_object)) = (
        payload.as_object_mut(),
        extra.and_then(|value| value.as_object().cloned()),
    ) {
        for (key, value) in extra_object {
            object.insert(key, value);
        }
    }
    write_json_file(&path, &payload)?;
    if ttl_ms > 0 {
        spawn_ttl_reset(ttl_ms, payload["updatedAt"].as_str().unwrap_or_default())?;
    }
    Ok(())
}

fn apply_window_visibility(
    window: &tauri::WebviewWindow,
    config: &CompanionConfig,
    force_position: bool,
    focus: bool,
) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_always_on_top(config.window.always_on_top);
    if force_position {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: DEFAULT_WINDOW_X,
            y: DEFAULT_WINDOW_Y,
        }));
    } else if let (Some(x), Some(y)) = (config.window.x, config.window.y) {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
    if focus {
        let _ = window.set_focus();
    }
}

fn reveal_main_window(app: &AppHandle, force_position: bool, focus: bool) -> Result<(), String> {
    let config = read_config_inner()?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Missing main window".to_string())?;
    apply_window_visibility(&window, &config, force_position, focus);
    Ok(())
}

#[cfg(windows)]
fn spawn_command_hidden(exe: &Path, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn spawn_gui_detached(exe: &Path, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const DETACHED_PROCESS: u32 = 0x00000008;
    let spawn = |flags| {
        Command::new(exe)
            .args(args)
            .creation_flags(flags)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    spawn(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
        .or_else(|_| spawn(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn spawn_command_hidden(exe: &Path, args: &[&str]) -> Result<(), String> {
    Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn spawn_gui_detached(exe: &Path, args: &[&str]) -> Result<(), String> {
    spawn_command_hidden(exe, args)
}

fn spawn_ttl_reset(ttl_ms: u64, expected_updated_at: &str) -> Result<(), String> {
    let exe = current_exe_path()?;
    spawn_command_hidden(
        &exe,
        &[
            "--ttl-reset",
            "--expected-updated-at",
            expected_updated_at,
            "--ttl-ms",
            &ttl_ms.to_string(),
        ],
    )
}

fn run_ttl_reset(args: &[String]) -> Result<(), String> {
    let ttl_ms = arg_value(args, "--ttl-ms")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let expected = arg_value(args, "--expected-updated-at").unwrap_or_default();
    std::thread::sleep(std::time::Duration::from_millis(ttl_ms));
    let path = state_path()?;
    let current = read_json_file(&path).unwrap_or_else(|_| json!({}));
    if current.get("updatedAt").and_then(Value::as_str) == Some(expected.as_str()) {
        write_state_inner("idle", "ttl-expired", 0, None)?;
    }
    Ok(())
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn read_stdin_json() -> Option<Value> {
    use std::io::{self, Read};
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() || input.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&input).ok()
}

fn hook_event_name(input: Option<&Value>) -> Option<&str> {
    input
        .and_then(|value| {
            value
                .get("hook_event_name")
                .or_else(|| value.get("hookEventName"))
                .or_else(|| value.get("event"))
        })
        .and_then(Value::as_str)
}

fn infer_hook_state(input: Option<&Value>) -> (&'static str, String, u64) {
    match hook_event_name(input) {
        Some("Notification") => {
            let notification_type = input
                .and_then(|value| value.get("notification_type"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            match notification_type {
                "auth_success" | "elicitation_complete" | "elicitation_response" => {
                    ("idle", format!("notification:{notification_type}"), 0)
                }
                "permission_prompt" | "elicitation_dialog" => {
                    ("waiting", format!("notification:{notification_type}"), 0)
                }
                _ => ("waiting", format!("notification:{notification_type}"), 8000),
            }
        }
        Some("PreToolUse") => {
            let tool_name = input
                .and_then(|value| value.get("tool_name"))
                .and_then(Value::as_str);
            match tool_name {
                Some("AskUserQuestion") => ("waiting", "ask-user-question".to_string(), 0),
                Some("ExitPlanMode") => ("waiting", "exit-plan-mode".to_string(), 0),
                _ => ("running", "pre-tool-use".to_string(), 0),
            }
        }
        Some(event_name) => HOOK_EVENTS
            .iter()
            .find(|(name, _, _, _)| *name == event_name)
            .map(|(_, state, event, ttl_ms)| (*state, (*event).to_string(), *ttl_ms))
            .unwrap_or(("idle", event_name.to_string(), 0)),
        None => ("idle", "unknown".to_string(), 0),
    }
}

fn approval_id(input: Option<&Value>) -> String {
    let session = input
        .and_then(|value| value.get("session_id").or_else(|| value.get("sessionId")))
        .and_then(Value::as_str)
        .unwrap_or("session");
    let tool = input
        .and_then(|value| value.get("tool_name").or_else(|| value.get("toolName")))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    sanitize_id(&format!("{session}-{tool}-{}", now_iso_like()))
}

fn is_decision_tool(input: Option<&Value>) -> bool {
    let Some(value) = input else {
        return false;
    };
    if hook_event_name(input) != Some("PreToolUse") {
        return false;
    }
    matches!(
        value
            .get("tool_name")
            .or_else(|| value.get("toolName"))
            .and_then(Value::as_str),
        Some("Bash" | "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
    )
}

fn wait_for_approval(id: &str, timeout_ms: u64) -> Result<Option<String>, String> {
    let path = approval_path(id)?;
    let started = SystemTime::now();
    loop {
        if path.is_file() {
            let value = read_json_file(&path)?;
            let decision = value
                .get("decision")
                .and_then(Value::as_str)
                .map(str::to_string);
            let _ = fs::remove_file(path);
            return Ok(decision);
        }
        let elapsed = SystemTime::now()
            .duration_since(started)
            .map_err(|error| error.to_string())?
            .as_millis() as u64;
        if elapsed >= timeout_ms {
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn pet_is_online(max_age_ms: u128) -> bool {
    let Ok(path) = heartbeat_path() else {
        return false;
    };
    let Ok(value) = read_json_file(&path) else {
        return false;
    };
    let Some(updated_at) = value
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<u128>().ok())
    else {
        return false;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    now.as_millis().saturating_sub(updated_at) <= max_age_ms
}

fn run_hook(args: &[String]) -> Result<(), String> {
    let input = read_stdin_json();
    if is_decision_tool(input.as_ref()) {
        if !pet_is_online(4000) {
            write_state_inner(
                "waiting",
                "approval-request-terminal",
                8000,
                Some(json!({
                    "requiresDecision": false,
                    "toolName": input
                        .as_ref()
                        .and_then(|value| value.get("tool_name").or_else(|| value.get("toolName")))
                        .and_then(Value::as_str),
                    "toolInputSummary": tool_input_summary(input.as_ref()),
                    "message": tool_input_summary(input.as_ref())
                })),
            )?;
            return Ok(());
        }
        let id = approval_id(input.as_ref());
        let tool_name = input
            .as_ref()
            .and_then(|value| value.get("tool_name").or_else(|| value.get("toolName")))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        write_state_inner(
            "waiting",
            "approval-request",
            0,
            Some(json!({
                "approvalId": id,
                "approvalKind": "tool",
                "requiresDecision": true,
                "toolName": tool_name,
                "toolInputSummary": tool_input_summary(input.as_ref()),
                "message": tool_input_summary(input.as_ref())
            })),
        )?;
        match wait_for_approval(&id, 120_000)? {
            Some(decision) if decision == "allow" => {
                println!(
                    "{}",
                    json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "allow",
                            "permissionDecisionReason": "Approved from Claude Pet Companion"
                        }
                    })
                );
                write_state_inner(
                    "running",
                    "approval-allowed",
                    0,
                    Some(json!({ "approvalId": id })),
                )?;
            }
            Some(_) => {
                println!(
                    "{}",
                    json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "Denied from Claude Pet Companion"
                        }
                    })
                );
                write_state_inner(
                    "idle",
                    "approval-denied",
                    0,
                    Some(json!({ "approvalId": id })),
                )?;
            }
            None => {
                println!(
                    "{}",
                    json!({
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "Timed out waiting for Claude Pet Companion approval"
                        }
                    })
                );
                write_state_inner(
                    "idle",
                    "approval-timeout",
                    0,
                    Some(json!({ "approvalId": id })),
                )?;
            }
        }
        return Ok(());
    }

    let (inferred_state, inferred_event, inferred_ttl) = infer_hook_state(input.as_ref());
    let state = arg_value(args, "--state").unwrap_or_else(|| inferred_state.to_string());
    let event = match hook_event_name(input.as_ref()) {
        Some("Notification") | Some("PreToolUse") => inferred_event,
        _ => arg_value(args, "--event").unwrap_or(inferred_event),
    };
    let ttl_ms = arg_value(args, "--ttl-ms")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(inferred_ttl);
    let extra = input.map(|value| {
        json!({
            "hookEventName": hook_event_name(Some(&value)),
            "toolName": value.get("tool_name").or_else(|| value.get("toolName")).cloned().unwrap_or(Value::Null),
            "notificationType": value.get("notification_type").cloned().unwrap_or(Value::Null),
            "sessionId": value.get("session_id").or_else(|| value.get("sessionId")).cloned().unwrap_or(Value::Null),
            "message": value.get("message").cloned().unwrap_or(Value::Null),
            "toolInputSummary": tool_input_summary(Some(&value)).map(Value::String).unwrap_or(Value::Null)
        })
    });
    write_state_inner(&state, &event, ttl_ms, extra)
}

fn same_directory(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn file_modified(path: &Path) -> Option<SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

fn target_needs_pet_copy(source: &Path, source_pet: &PetInfo, target: &Path) -> bool {
    if !target.is_dir() || read_manifest(target).is_err() {
        return true;
    }
    let source_manifest = source.join("pet.json");
    let target_manifest = target.join("pet.json");
    let target_spritesheet = target.join("spritesheet.webp");
    let source_manifest_time = file_modified(&source_manifest);
    let source_sheet_time = file_modified(Path::new(&source_pet.spritesheet_path));
    let target_manifest_time = file_modified(&target_manifest);
    let target_sheet_time = file_modified(&target_spritesheet);

    source_manifest_time > target_manifest_time || source_sheet_time > target_sheet_time
}

fn import_pet_package_inner(
    source: &Path,
    activate: bool,
    announce: bool,
) -> Result<PetInfo, String> {
    let pet = read_manifest(source)?;
    let target = companion_pets_dir()?.join(&pet.id);
    let source_is_target = target.is_dir() && same_directory(source, &target);

    if target.exists() && !source_is_target {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }

    if !source_is_target {
        fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        fs::copy(&pet.spritesheet_path, target.join("spritesheet.webp"))
            .map_err(|error| error.to_string())?;
        let normalized_manifest = json!({
            "id": pet.id,
            "displayName": pet.display_name,
            "description": pet.description,
            "spritesheetPath": "spritesheet.webp"
        });
        write_json_file(&target.join("pet.json"), &normalized_manifest)?;
    }

    let imported = read_manifest(&target)?;
    if activate {
        let mut config = read_config_inner()?;
        config.active_pet_id = imported.id.clone();
        write_config_inner(&config)?;
    }
    if announce {
        write_state_inner(
            "review",
            "pet-imported",
            3000,
            Some(json!({
                "petId": imported.id,
                "displayName": imported.display_name
            })),
        )?;
    }
    Ok(imported)
}

fn sync_codex_pets_inner() -> Result<Vec<PetInfo>, String> {
    let source_root = codex_pets_dir()?;
    let Ok(entries) = fs::read_dir(source_root) else {
        return Ok(Vec::new());
    };

    let mut synced = Vec::new();
    for entry in entries.flatten() {
        let source = entry.path();
        if !source.is_dir() {
            continue;
        }

        let Ok(pet) = read_manifest(&source) else {
            continue;
        };

        let target = companion_pets_dir()?.join(&pet.id);
        if !same_directory(&source, &target) && target_needs_pet_copy(&source, &pet, &target) {
            let imported = import_pet_package_inner(&source, false, false)?;
            synced.push(imported);
            continue;
        }

        synced.push(pet);
    }
    synced.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(synced)
}

fn set_active_pet_inner(id: &str) -> Result<(), String> {
    let config = read_config_inner()?;
    let pets = list_pets_inner(&config);
    if !pets.iter().any(|pet| pet.id == id) {
        return Err(format!("Unknown pet id: {id}"));
    }
    let mut next = config;
    next.active_pet_id = id.to_string();
    write_config_inner(&next)?;
    write_state_inner("waving", "pet-switched", 3000, Some(json!({ "petId": id })))
}

fn launch_existing_or_new(args: &[String]) -> Result<(), String> {
    let state = arg_value(args, "--state").unwrap_or_else(|| "waving".to_string());
    let event = arg_value(args, "--event").unwrap_or_else(|| "launch".to_string());
    let ttl_ms = arg_value(args, "--ttl-ms")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(3000);
    write_state_inner(&state, &event, ttl_ms, None)?;
    let exe = current_exe_path()?;
    spawn_gui_detached(&exe, &["--show", "--force-position", "--focus"])?;
    Ok(())
}

fn run_cli(args: &[String]) -> Result<bool, String> {
    if args.iter().any(|arg| arg == "--install") {
        let _ = read_config_inner()?;
        install_hooks_inner(true)?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--uninstall") {
        uninstall_hooks_inner()?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--install-command") {
        install_pet_command_inner()?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--hook") {
        run_hook(args)?;
        return Ok(true);
    }
    if let Some(source) = arg_value(args, "--import-pet") {
        import_pet_package_inner(&PathBuf::from(source), true, true)?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--sync-codex-pets") {
        let synced = sync_codex_pets_inner()?;
        write_state_inner(
            "review",
            "codex-pets-synced",
            3000,
            Some(json!({ "count": synced.len() })),
        )?;
        return Ok(true);
    }
    if let Some(id) = arg_value(args, "--set-pet") {
        set_active_pet_inner(&id)?;
        if args.iter().any(|arg| arg == "--launch") {
            launch_existing_or_new(args)?;
        }
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--launch") {
        launch_existing_or_new(args)?;
        return Ok(true);
    }
    if args.iter().any(|arg| arg == "--ttl-reset") {
        run_ttl_reset(args)?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn get_config() -> Result<CompanionConfig, String> {
    read_config_inner()
}

#[tauri::command]
fn save_config(config: CompanionConfig, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(config.window.always_on_top);
    }
    write_config_inner(&config)
}

#[tauri::command]
fn list_pets() -> Result<Vec<PetInfo>, String> {
    let config = read_config_inner()?;
    Ok(list_pets_inner(&config))
}

#[tauri::command]
fn read_state() -> Result<Value, String> {
    let path = state_path()?;
    if !path.is_file() {
        return Ok(json!({
            "state": "idle",
            "event": "initial",
            "updatedAt": "",
            "ttlMs": 0
        }));
    }
    read_json_file(&path)
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = match path.extension().and_then(OsStr::to_str).unwrap_or("") {
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
fn import_pet(source_dir: String) -> Result<PetInfo, String> {
    import_pet_package_inner(&PathBuf::from(source_dir), true, true)
}

#[tauri::command]
fn sync_codex_pets() -> Result<Vec<PetInfo>, String> {
    sync_codex_pets_inner()
}

#[tauri::command]
fn write_pet_heartbeat() -> Result<(), String> {
    write_json_file(
        &heartbeat_path()?,
        &json!({
            "updatedAt": now_iso_like()
        }),
    )
}

#[tauri::command]
fn write_approval_decision(approval_id: String, decision: String) -> Result<(), String> {
    let id = sanitize_id(&approval_id);
    let decision = if decision == "allow" { "allow" } else { "deny" };
    write_json_file(
        &approval_path(&id)?,
        &json!({
            "decision": decision,
            "updatedAt": now_iso_like()
        }),
    )
}

#[tauri::command]
fn start_window_drag(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Missing main window".to_string())?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn reset_window_position(app: AppHandle) -> Result<(), String> {
    let mut config = read_config_inner()?;
    config.window.x = Some(DEFAULT_WINDOW_X);
    config.window.y = Some(DEFAULT_WINDOW_Y);
    write_config_inner(&config)?;
    reveal_main_window(&app, true, true)
}

#[tauri::command]
fn close_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let args: Vec<String> = env::args().collect();
    let initial_force_position = args
        .iter()
        .any(|arg| arg == "--force-position" || arg == "--launch");
    let initial_focus = initial_force_position || args.iter().any(|arg| arg == "--focus");
    match run_cli(&args) {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            let _ = write_state_inner("failed", "cli-error", 3000, Some(json!({ "error": error })));
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let force_position = args
                .iter()
                .any(|arg| arg == "--force-position" || arg == "--launch");
            let focus = force_position || args.iter().any(|arg| arg == "--focus");
            let _ = reveal_main_window(app, force_position, focus);
            let _ = app.emit("single-instance", SingleInstancePayload { args, cwd });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let _ = ensure_user_installation();
            let config =
                read_config_inner().unwrap_or_else(|_| default_config().expect("default config"));
            if let Some(window) = app.get_webview_window("main") {
                apply_window_visibility(&window, &config, initial_force_position, initial_focus);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_app,
            get_config,
            import_pet,
            list_pets,
            load_image_data_url,
            read_state,
            reset_window_position,
            save_config,
            start_window_drag,
            sync_codex_pets,
            write_pet_heartbeat,
            write_approval_decision
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Pet Companion");
}
