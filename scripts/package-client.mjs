import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const publicRelease = process.argv.includes('--public');
const out = path.resolve(publicRelease ? 'release/public/SofaMate' : 'release/SofaMate');
await fs.mkdir(out, { recursive: true });
const exe = await fs.readFile('experiments/tauri-client/src-tauri/target/release/screenmate-trial.exe');
await fs.writeFile(path.join(out, 'SofaMate.exe'), exe);
let catalog = [];
if (!publicRelease) {
  try { catalog = JSON.parse(await fs.readFile('reports/tauri-trial/20260918/trial-catalog.json', 'utf8')).filter(p => p.scope === 'approved-demo'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.writeFile(path.join(out, 'trial-catalog.json'), JSON.stringify(catalog, null, 2));
await fs.writeFile(path.join(out, '使用说明.txt'), `SofaMate · Windows public beta
https://sofamate.aveniqa.com

双击 SofaMate.exe。导入 MP4 视频，自动生成九宫格并设为桌面壁纸。支持 H.264 视频与 AAC 音频，单文件最大 1 GiB。
本机使用不需要账号。右上角登录后，可将自己的视频分享到公开市场。浏览和下载无需登录，下载后可以离线播放。登录在系统浏览器中完成，请核对配对码。
壁纸库保存在 %LOCALAPPDATA%\\ScreenMate\\library（保留目录名以兼容早期版本）。视频会复制到库中，原文件不会被修改。公开版不捆绑截图中的主题视频。
预览播放/暂停只控制面板视频。设为壁纸旁的下拉菜单提供桌面暂停、继续、停止及音量。停止释放桌面播放器；继续重新加载上次壁纸。关闭面板不停止壁纸；双击托盘打开面板，右键显示菜单。每次运行默认静音；右上角可切换中文、英文、日文。
Windows 10/11 x64，需要系统 WebView2 Runtime。客户端不需要 Node.js 或 FFmpeg。

Extract the ZIP and launch SofaMate.exe. Import your own H.264/AAC MP4 (up to 1 GiB), preview it and choose Set as wallpaper. Local playback needs no account. Sign in through your system browser to publish. Downloads remain available offline. Requires Windows 10/11 x64 and Microsoft Edge WebView2 Runtime. Demo artwork is not bundled.
`);
await fs.copyFile('THIRD_PARTY_NOTICES.md', path.join(out, 'THIRD_PARTY_NOTICES.md'));
await fs.copyFile('THIRD_PARTY_LICENSES.txt', path.join(out, 'THIRD_PARTY_LICENSES.txt'));
await fs.writeFile(path.join(out, 'BUILD-INFO.json'), JSON.stringify({ builtAt: new Date().toISOString(), runtime: 'Tauri + WebView2', bytes: exe.length, sha256: createHash('sha256').update(exe).digest('hex'), publicMarket: true }, null, 2));
console.log(out);
