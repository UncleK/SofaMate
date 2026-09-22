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
    fn FindWindowW(class:*const u16,title:*const u16)->isize;
    fn FindWindowExW(parent:isize,after:isize,class:*const u16,title:*const u16)->isize;
    fn SetParent(child:isize,parent:isize)->isize;
    fn SetWindowPos(hwnd:isize,after:isize,x:i32,y:i32,width:i32,height:i32,flags:u32)->i32;
    fn MapWindowPoints(from:isize,to:isize,point:*mut Point,count:u32)->i32;
    fn SetLayeredWindowAttributes(hwnd:isize,key:u32,alpha:u8,flags:u32)->i32;
    fn GetWindowRect(hwnd:isize,rect:*mut Rect)->i32;
    fn GetClientRect(hwnd:isize,rect:*mut Rect)->i32;
    fn ClientToScreen(hwnd:isize,point:*mut Point)->i32;
    fn SetWindowRgn(hwnd:isize,region:isize,redraw:i32)->i32;
}
#[link(name="gdi32")]
unsafe extern "system"{fn CreateRectRgn(left:i32,top:i32,right:i32,bottom:i32)->isize;fn DeleteObject(object:isize)->i32;}
#[repr(C)]struct Point{x:i32,y:i32}
#[repr(C)]#[derive(Default)]struct Rect{left:i32,top:i32,right:i32,bottom:i32}
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
fn raised_desktop()->Option<(isize,isize)>{unsafe{
    let progman=FindWindowW(wide("Progman").as_ptr(),std::ptr::null());
    let icons=FindWindowExW(progman,0,wide("SHELLDLL_DefView").as_ptr(),std::ptr::null());
    (progman!=0 && icons!=0 && GetWindowLongPtrW(progman,-20)&0x00200000!=0).then_some((progman,icons))
}}
pub fn is_attached(w:&WebviewWindow)->bool {
    w.hwnd().map(|h|unsafe {let parent=GetParent(h.0 as isize);parent!=0 && GetWindowLongPtrW(h.0 as isize,-16)&0x40000000!=0 && raised_desktop().map(|(p,_)|p==parent).unwrap_or(true)}).unwrap_or(false)
}
pub fn show(w:&WebviewWindow)->Result<(),String> {
    let hwnd=w.hwnd().map_err(|e|e.to_string())?.0 as isize;
    // Tauri show() reapplies its cached top-level style, losing WS_CHILD.
    w.run_on_main_thread(move||unsafe{ShowWindow(hwnd,4);}).map_err(|e|e.to_string())
}
pub fn fits(w:&WebviewWindow,monitor:&crate::displays::Display)->bool{w.hwnd().map(|h|unsafe{let mut r=Rect::default();let mut p=Point{x:0,y:0};GetClientRect(h.0 as isize,&mut r)!=0&&ClientToScreen(h.0 as isize,&mut p)!=0&&p.x==monitor.x&&p.y==monitor.y&&r.right==monitor.width as i32&&r.bottom==monitor.height as i32}).unwrap_or(false)}
pub fn attach(app:&tauri::AppHandle,w:&WebviewWindow,monitor:&crate::displays::Display)->Result<isize,String>{
    // Tauri setters are queued when called off-thread. Keep style updates and
    // SetParent in one UI-thread task so later setters cannot restore WS_POPUP.
    let (tx,rx)=std::sync::mpsc::channel();
    let app=app.clone();let window=w.clone();let monitor=monitor.clone();
    w.run_on_main_thread(move||{let _=tx.send(attach_on_main(&app,&window,&monitor));}).map_err(|e|e.to_string())?;
    rx.recv().map_err(|e|e.to_string())?
}
fn attach_on_main(app:&tauri::AppHandle,w:&WebviewWindow,monitor:&crate::displays::Display)->Result<isize,String>{
    let hwnd=w.hwnd().map_err(|e|e.to_string())?.0 as isize;
    // Switching resolution must not reparent/reset a working native video surface.
    let parent=unsafe{GetParent(hwnd)};
    if is_attached(w)&&fits(w,monitor){return Ok(parent)}
    // These setters rebuild native styles, so do them before SetParent.
    w.set_skip_taskbar(true).map_err(|e|e.to_string())?;
    w.set_focusable(false).map_err(|e|e.to_string())?;
    w.set_decorations(false).map_err(|e|e.to_string())?;
    w.set_ignore_cursor_events(true).map_err(|e|e.to_string())?;
    unsafe {let style=GetWindowLongPtrW(hwnd,-16);SetWindowLongPtrW(hwnd,-16,(style|0x40000000)&!0x80000000);
        let ex=GetWindowLongPtrW(hwnd,-20);SetWindowLongPtrW(hwnd,-20,(ex|0x08000080)&!0x00040008);}
    if let Some((progman,icons))=raised_desktop(){
        // On the raised Windows 11 desktop, the traditional WorkerW is covered
        // by Progman's surface. Match the desktop's actual icon sibling layer.
        unsafe{
            let ex=GetWindowLongPtrW(hwnd,-20);SetWindowLongPtrW(hwnd,-20,ex|0x00080000);
            if SetLayeredWindowAttributes(hwnd,0,255,2)==0{return Err("Could not compose wallpaper on the raised desktop".into())}
            SetParent(hwnd,progman);
            let mut point=Point{x:monitor.x,y:monitor.y};
            MapWindowPoints(0,progman,&mut point,1);
            if SetWindowPos(hwnd,icons,point.x,point.y,monitor.width as i32,monitor.height as i32,0x10|0x20)==0{return Err("Could not position wallpaper on the desktop".into())}
            let(mut rect,mut client)=(Rect::default(),Rect::default());let mut origin=Point{x:0,y:0};
            if GetWindowRect(hwnd,&mut rect)==0||GetClientRect(hwnd,&mut client)==0||ClientToScreen(hwnd,&mut origin)==0{return Err("Could not measure the wallpaper surface".into())}
            let left=origin.x-rect.left;let top=origin.y-rect.top;
            let right=rect.right-rect.left-client.right-left;let bottom=rect.bottom-rect.top-client.bottom-top;
            if SetWindowPos(hwnd,icons,point.x-left,point.y-top,monitor.width as i32+left+right,monitor.height as i32+top+bottom,0x10)==0{return Err("Could not fill the wallpaper display".into())}
        }
    }else{
        app.wallpaper().attach(AttachRequest::new(w.label()).with_monitor(&monitor.name)).map_err(|e|e.to_string())?;
    }
    let parent=unsafe{GetParent(hwnd)};
    if parent==0{return Err("Plugin returned without an actual desktop parent".into())}
    // The compensated non-client frame extends into an adjacent display. Clip
    // the native surface to its client area; do not crop or enlarge the video.
    unsafe{
        let(mut rect,mut client)=(Rect::default(),Rect::default());let mut origin=Point{x:0,y:0};
        if GetWindowRect(hwnd,&mut rect)==0||GetClientRect(hwnd,&mut client)==0||ClientToScreen(hwnd,&mut origin)==0{return Err("Could not measure desktop clip".into())}
        let left=origin.x-rect.left;let top=origin.y-rect.top;
        let region=CreateRectRgn(left,top,left+client.right,top+client.bottom);
        if region==0{return Err("Could not create desktop clip".into())}
        if SetWindowRgn(hwnd,region,1)==0{DeleteObject(region);return Err("Could not clip wallpaper to its display".into())}
    }
    Ok(parent)
}
pub fn watch(app:tauri::AppHandle){std::thread::spawn(move||loop{
    std::thread::sleep(std::time::Duration::from_secs(2));
    let _=crate::runtime::reconcile(&app);
});}
