# Windows 桌面壁纸宿主

2026-09-20 宿主更新：当前唯一客户端为 Tauri + WebView2，实际挂载实现为 experiments/tauri-client/src-tauri/src/desktop.rs。旧 Electron 入口、PowerShell 宿主桥接已删除；native/DesktopHost.cs 仅供只读窗口诊断。单视频壁纸与原 Scene Pack 共用同一桌面窗口，关闭面板继续播放，每次启动默认静音。下文 Electron 适配内容仅作历史，不是当前实现。

2026-09-18 用户明确要求“启动之后自动进入全屏后置状态，只在右下方状态栏留一个小图标，右键呼出控制菜单”。这取代此前只做独立场景预览、真正壁纸宿主后置的阶段安排。

用户版采用独立壁纸窗口与控制面板。壁纸窗口无边框、不抢焦点、鼠标穿透、不出现在任务栏、不置顶；挂在 Windows 桌面图标及普通应用窗口后面，覆盖主屏完整区域。关闭面板不停止壁纸。托盘左键双击打开面板，右键提供暂停、继续、停止和退出。停止销毁壁纸窗口并保留上次选择；继续重新加载上次壁纸。暂停则保留播放器和位置。停止状态持久化，退出后再打开也不会自行播放。没有设置系统开机自启动。

当前视频是 1280×720 的完整不透明房间。窗口支持透明合成，不代表视频已有透明人物通道；4K 主屏上仍是 720P 源按比例显示。保留原始宽高比，不裁切背景来填充异形屏幕。每次启动默认静音，用户通过托盘“开启声音（50%）”或控制面板音量滑块手动开声；旧版保存的音量不影响默认静音。

## 实现与限制

native/DesktopHost.cs 只接收当前 ScreenMate 进程的窗口句柄。验证桌面窗口归属 explorer 后，识别经典 WorkerW 或 Windows 11 raised desktop；设置子窗口样式，将窗口放在桌面图标下面，按主屏物理像素定位。src/main/desktop-host.ts 用隐藏的 PowerShell 子进程调用本地 helper，无运行时安装包或模型。不能挂接时显示错误并返回控制面板，不用置顶窗口冒充壁纸。

真实测试同时验证 Win32 父窗口/样式和 Electron 渲染状态。只通过 Win32 显示窗口不足以通知 Chromium 恢复呈现；此轮修复了这种情况下约每秒一次回调、最终触发末帧超时的问题。显示时同步 Electron widget，再恢复桌面层级。桌面窗口禁用遮挡导致的渲染降频；隐藏、锁屏和系统挂起仍暂停播放。

当前只验证本机 Windows 11、单主屏、200% 缩放下的 3840×2160 覆盖。Explorer 重启恢复、多屏、虚拟桌面切换和不同 Windows 版本仍需专门适配验收。WorkerW/raised desktop 属于 Explorer 实现细节，不是微软承诺稳定的动态壁纸 API。

参考：[SetParent 样式/DPI 约束](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)，[Lively 桌面宿主实现](https://github.com/rocksdanister/lively/blob/core-separation/src/Lively/Lively/Core/WinDesktopCore.cs)，[Electron 可见性说明](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)，[Chromium 遮挡控制开关](https://chromium.googlesource.com/chromium/src/+/lkgr/content/public/common/content_switches.cc)。本项目未引入 Lively 程序或程序集，未替用户选择项目许可证。
