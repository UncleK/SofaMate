//! Keep Tauri's window-style updates before reparenting. Win32 SetParent does not
//! change WS_CHILD/WS_POPUP itself (same contract used by the Electron host).
use tauri::WebviewWindow;
use tauri_plugin_wallpaper::{WallpaperExt, AttachRequest};
#[link(name="user32")]
unsafe extern "system" {
    fn GetWindowLongPtrW(hwnd:isize,index:i32)->isize;
    fn SetWindowLongPtrW(hwnd:isize,index:i32,value:isize)->isize;
    fn GetParent(hwnd:isize)->isize;
    fn ShowWindow(hwnd:isize,command:i32)->i32;
}
pub fn is_attached(w:&WebviewWindow)->bool {
    w.hwnd().map(|h|unsafe {GetParent(h.0 as isize)!=0 && GetWindowLongPtrW(h.0 as isize,-16)&0x40000000!=0}).unwrap_or(false)
}
pub fn show(w:&WebviewWindow)->Result<(),String> {
    let hwnd=w.hwnd().map_err(|e|e.to_string())?.0 as isize;
    // Tauri show() reapplies its cached top-level style, losing WS_CHILD.
    w.run_on_main_thread(move||unsafe{ShowWindow(hwnd,4);}).map_err(|e|e.to_string())
}
pub fn attach(app:&tauri::AppHandle,w:&WebviewWindow)->Result<isize,String>{
    // Tauri setters are queued when called off-thread. Keep style updates and
    // SetParent in one UI-thread task so later setters cannot restore WS_POPUP.
    let (tx,rx)=std::sync::mpsc::channel();
    let app=app.clone();let window=w.clone();
    w.run_on_main_thread(move||{let _=tx.send(attach_on_main(&app,&window));}).map_err(|e|e.to_string())?;
    rx.recv().map_err(|e|e.to_string())?
}
fn attach_on_main(app:&tauri::AppHandle,w:&WebviewWindow)->Result<isize,String>{
    let hwnd=w.hwnd().map_err(|e|e.to_string())?.0 as isize;
    // Switching resolution must not reparent/reset a working native video surface.
    let parent=unsafe{GetParent(hwnd)};
    if parent!=0 && unsafe{GetWindowLongPtrW(hwnd,-16)}&0x40000000!=0{return Ok(parent)}
    let monitor=app.primary_monitor().map_err(|e|e.to_string())?.ok_or("No display")?;
    // These setters rebuild native styles, so do them before SetParent.
    w.set_skip_taskbar(true).map_err(|e|e.to_string())?;
    w.set_focusable(false).map_err(|e|e.to_string())?;
    w.set_decorations(false).map_err(|e|e.to_string())?;
    w.set_ignore_cursor_events(true).map_err(|e|e.to_string())?;
    unsafe {let style=GetWindowLongPtrW(hwnd,-16);SetWindowLongPtrW(hwnd,-16,(style|0x40000000)&!0x80000000);
        let ex=GetWindowLongPtrW(hwnd,-20);SetWindowLongPtrW(hwnd,-20,(ex|0x08000080)&!0x00040008);}
    app.wallpaper().attach(AttachRequest::new("wallpaper").with_monitor(monitor.name().ok_or("Unnamed display")?)).map_err(|e|e.to_string())?;
    let parent=unsafe{GetParent(hwnd)};
    if parent==0{return Err("Plugin returned without an actual desktop parent".into())}
    Ok(parent)
}
