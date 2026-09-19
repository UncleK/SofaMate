use std::{sync::atomic::Ordering, thread, time::Duration};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use crate::{Trial, current_payload, library, desktop, WEBVIEW_ARGS};

pub fn payload(state: &Trial, id: &str) -> Result<Value, String> {
    let mut value = current_payload(state, id)?;
    value["selectionId"] = json!(id);
    value["playbackId"] = json!(state.generation.load(Ordering::SeqCst));
    value["volume"] = json!(*state.volume.lock().unwrap());
    Ok(value)
}
pub fn publish(app: &tauri::AppHandle, value: Value) {
    let state = app.state::<Trial>();
    *state.metrics.lock().unwrap() = value.clone();
    if let Some(path) = &state.report { let _ = std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()); }
    let _ = app.emit_to("controls", "trial-metrics", value);
}
fn open_player(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Trial>();
    let monitor = app.primary_monitor().map_err(|e| e.to_string())?.ok_or("No display")?;
    let size = monitor.size(); let pos = monitor.position(); let scale = monitor.scale_factor();
    let mut builder = WebviewWindowBuilder::new(app, "wallpaper", WebviewUrl::App("index.html?wallpaper=1".into()))
        .title("SofaMate").visible(false).decorations(false).resizable(false).skip_taskbar(state.desktop_mode).focused(false)
        .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        .position(pos.x as f64 / scale, pos.y as f64 / scale).additional_browser_args(WEBVIEW_ARGS);
    if !state.desktop_mode { builder = builder.inner_size(1152.,648.).position(30.,30.); }
    let window = builder.build().map_err(|e| e.to_string())?;
    window.set_icon(tauri::image::Image::from_bytes(include_bytes!("../../../../assets/brand/native/screenmate-128.png")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if state.desktop_mode {
        desktop::attach(app, &window)?;
        *state.attached.lock().unwrap() = true;
    }
    desktop::show(&window)?;
    Ok(())
}
pub fn start(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<Trial>(); let _transition = state.transition.lock().unwrap();
    current_payload(&state, id)?;
    if id.is_empty() { return Err("本机壁纸不存在".into()); }
    library::save_json(&state.library.root.join("selected.json"), &id)?;
    library::save_json(&state.library.root.join("playback-enabled.json"), &true)?;
    *state.selected.lock().unwrap() = id.to_string();
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.enabled.store(true, Ordering::SeqCst);
    publish(app, json!({"selectionId": id, "playbackId":state.generation.load(Ordering::SeqCst), "loading":true,"stopped":false,"paused":true,"frames":0,"fault":null,"volume":*state.volume.lock().unwrap()}));
    let result = if let Some(window) = app.get_webview_window("wallpaper") {
        desktop::show(&window)?;
        app.emit_to("wallpaper", "trial-command", json!({"action":"load","payload":payload(&state,id)?})).map_err(|e| e.to_string())
    } else { open_player(app) };
    if let Err(error) = &result {
        state.enabled.store(false,Ordering::SeqCst);
        state.generation.fetch_add(1,Ordering::SeqCst);
        if let Some(window)=app.get_webview_window("wallpaper"){let _=window.hide();let _=window.destroy();}
        *state.attached.lock().unwrap()=false;
        let _=library::save_json(&state.library.root.join("playback-enabled.json"),&false);
        publish(app, json!({"selectionId":null,"paused":true,"stopped":true,"loading":false,"fault":error,"frames":0}));
    }
    result
}
pub fn stop(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Trial>(); let _transition = state.transition.lock().unwrap();
    library::save_json(&state.library.root.join("playback-enabled.json"), &false)?;
    state.enabled.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("wallpaper") {
        window.hide().map_err(|e| e.to_string())?;
        window.destroy().map_err(|e| e.to_string())?;
        for _ in 0..100 {
            if app.get_webview_window("wallpaper").is_none() { break; }
            thread::sleep(Duration::from_millis(10));
        }
    }
    *state.attached.lock().unwrap() = false;
    publish(app, json!({"selectionId":null,"playbackId":state.generation.load(Ordering::SeqCst),"stopped":true,"paused":true,"frames":0,"videoSlots":0,"fault":null,"volume":*state.volume.lock().unwrap()}));
    if app.get_webview_window("wallpaper").is_some() { return Err("播放器仍在释放，请稍候".into()); }
    Ok(())
}
pub fn resume(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Trial>();
    if app.get_webview_window("wallpaper").is_none() || !state.enabled.load(Ordering::SeqCst) {
        let id = state.selected.lock().unwrap().clone();
        return start(app, &id);
    }
    crate::command(app, "resume", Value::Null);
    Ok(())
}
pub fn tray_text(id: &str, lang: &str) -> &'static str {
    let index = if lang == "en" {1} else if lang == "ja" {2} else {0};
    match id {
        "controls" => ["打开控制面板", "Open controls", "コントロールを開く"][index],
        "pause" => ["暂停", "Pause", "一時停止"][index],
        "resume" => ["继续", "Resume", "再開"][index],
        "stop" => ["停止", "Stop", "停止"][index],
        "mute" => ["静音", "Mute", "ミュート"][index],
        "sound" => ["开启声音（50%）", "Sound on (50%)", "音声オン（50%）"][index],
        _ => ["退出 SofaMate", "Quit SofaMate", "SofaMate を終了"][index],
    }
}
pub fn volume(app: &tauri::AppHandle, value: f64) {
    *app.state::<Trial>().volume.lock().unwrap() = value;
    crate::command(app, "volume", json!(value));
}
