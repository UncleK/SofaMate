<p align="center"><img src="site/assets/social-card.png" alt="SofaMate" width="100%"></p>

<p align="center"><b>SofaMate · 沙发伴侣</b><br>打开桌面，就有陪伴。把喜欢的角色留在 Windows 桌面，陪你工作、学习和独处的时光。</p>

<p align="center"><a href="https://sofamate.aveniqa.com">官网</a> · <a href="https://github.com/UncleK/SofaMate/releases/latest">下载</a> · <a href="https://sofamate.aveniqa.com/market">分享市场</a> · <a href="README.md">English</a> · <a href="README.ja.md">日本語</a></p>

![精选主题的真实 Windows 客户端截图](site/assets/client-featured.png)

## 你喜欢的桌面陪伴

喜欢她的温柔，也可以喜欢他的笑容。把让你心动的人物视频留在桌面，一个人工作、学习，或只是待着时，也有一份陪伴的感觉。

导入喜欢的 MP4，客户端自动生成九宫格预览。点击「设为壁纸」，人物画面便留在桌面图标后方。本机视频与已安装主题统一收在「我的壁纸」，支持搜索和左右切换。

| 本机使用 | 播放控制 | 分享社区 |
| --- | --- | --- |
| 无需账号，导入后离线播放 | 面板预览与桌面播放独立 | 注册登录后发布，所有人可浏览、下载 |
| 九宫格在本机生成 | 暂停、继续、停止、音量集中在小菜单 | Aveniqa 统一账号：邮箱验证码、GitHub、Google |
| 简体中文、英文、日文 | 启动默认静音，停止释放桌面播放器 | 下载到本机后，可离线使用 |

![我的壁纸](site/assets/client-library.png)

## 开始使用

可以先在[发现作品](https://sofamate.aveniqa.com/market)观看预览，选择喜欢的作品，再通过客户端下载完整主题。官方作品和社区作品共用市场，官方精选目前包含 SofaMate_collection 发布的主题。

1. [下载 Windows ZIP](https://github.com/UncleK/SofaMate/releases/latest/download/SofaMate-Windows-x64.zip)，解压。
2. 双击 `SofaMate.exe`，下载精选主题或市场作品，也可以导入自己的 H.264 / AAC MP4。
3. 选择显示器和画质，再点击「设为壁纸」。多台显示器可以分别显示不同作品；选择已下载的画质后，点击应用才会切换桌面。

关闭面板后，壁纸继续播放。双击托盘图标打开面板，右键显示控制菜单。停止后点击继续，会重新加载上一次壁纸。

当前为公开测试版，支持 Windows 10/11 x64、多屏独立壁纸和单视频最大 1 GiB 的导入，需要系统 WebView2 Runtime。ZIP 约 1.95 MiB。客户端不捆绑 Chromium、Node.js 或 FFmpeg；安装包尚未代码签名。视频不随客户端捆绑，可单独下载官方完整主题、社区作品或导入自己的视频。默认壁纸库仍保留 `%LOCALAPPDATA%\ScreenMate\library` 路径，兼容早期版本。

夜间客厅提供 **720P24、1080P24、1080P60** 三种完整下载规格，4K 暂不开放公网下载。主题包含 28 段视频，随机起播并沿指定后续方向随机接片；普通导入视频仍按单视频循环。默认等比铺满并裁剪，也可选择完整画面留边，不拉伸人物。

新用户可在 Aveniqa 统一入口通过邮箱验证码、Google 或 GitHub 完成首次注册与验证，再返回 SofaMate。浏览、下载和本机播放无需登录；昵称只用于显示，官方精选权限由服务端单独管理。当前更新见[发布说明](docs/RELEASE_NOTES.md)。

## 开发与部署

构建需要 Node.js 24+、npm、Rust stable、Windows SDK 和 Visual Studio C++ Build Tools。FFmpeg 仅用于制作工具和生成测试素材。

```powershell
npm ci
npm run build
npm run package:public
```

运行验证前先执行 `npm ci --prefix experiments/tauri-client`，再运行 `npm run fixtures` → `npm run typecheck` → `npm run typecheck:client` → `npm test`。公开安装目录位于 `release/public/SofaMate/`。

市场与登录服务单独部署，不打进客户端。部署、账号及管理接口见 [服务说明](deploy/README.md)。代码许可证尚未指定，依赖及素材的权利分别保留，见 [第三方说明](THIRD_PARTY_NOTICES.md)。问题反馈请前往 [Issues](https://github.com/UncleK/SofaMate/issues)，不要公开邮箱、令牌或本机敏感路径。
