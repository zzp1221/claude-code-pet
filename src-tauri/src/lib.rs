use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const COMPANION_DIR: &str = ".claude/pet-companion";

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

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the user home directory".to_string())
}

fn companion_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(COMPANION_DIR))
}

fn config_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("config.json"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(companion_dir()?.join("runtime/state.json"))
}

fn default_config() -> Result<CompanionConfig, String> {
    let home = home_dir()?;
    let companion = companion_dir()?;
    Ok(CompanionConfig {
        active_pet_id: "hiyue".to_string(),
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
    serde_json::from_str(&text).map_err(|error| error.to_string())
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
fn read_state() -> Result<serde_json::Value, String> {
    let path = state_path()?;
    if !path.is_file() {
        return Ok(serde_json::json!({
            "state": "idle",
            "event": "initial",
            "updatedAt": "",
            "ttlMs": 0
        }));
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
fn import_pet(source_dir: String) -> Result<PetInfo, String> {
    let source = PathBuf::from(source_dir);
    let pet = read_manifest(&source)?;
    let companion = companion_dir()?;
    let target = companion.join("pets").join(&pet.id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    fs::copy(source.join("pet.json"), target.join("pet.json")).map_err(|error| error.to_string())?;
    fs::copy(&pet.spritesheet_path, target.join("spritesheet.webp"))
        .map_err(|error| error.to_string())?;

    let mut imported = read_manifest(&target)?;
    imported.spritesheet_path = target.join("spritesheet.webp").to_string_lossy().to_string();
    Ok(imported)
}

#[tauri::command]
fn start_window_drag(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Missing main window".to_string())?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_app(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = read_config_inner().unwrap_or_else(|_| default_config().expect("default config"));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(config.window.always_on_top);
                if let (Some(x), Some(y)) = (config.window.x, config.window.y) {
                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
                }
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
            save_config,
            start_window_drag
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Pet Companion");
}
