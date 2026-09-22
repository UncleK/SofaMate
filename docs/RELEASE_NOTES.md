# SofaMate 0.1.0 — September 22, 2026 update

## 简体中文

- 多显示器可分别设置壁纸、画质和显示方式；默认等比铺满，可选完整画面留边。
- 画质菜单分别标记当前选择和桌面使用中的规格。选择已下载画质后需点击「设为壁纸」；已在使用的组合显示「当前壁纸」。
- 统一九宫格预览和内部间距。官方作品进入市场与精选；社区作品可由有权限的管理员精选，昵称不授予管理权限。
- 夜间客厅提供 720P24、1080P24、1080P60 完整主题包，28 段视频沿指定后继随机播放，支持短转场。4K 暂不开放公网下载。
- 修复 Windows 11 桌面挂载与混合 DPI 双屏交界的窄边；改善视频尾帧回调遗漏时的接片处理。
- 官网三语介绍与现有功能同步。登录后各页面显示昵称，退出和跨标签页切换会同步状态。新用户通过 Aveniqa 统一注册和验证。
- Windows ZIP 约 1.95 MiB，视频单独下载，不携带 Chromium、Node.js 或 FFmpeg。

## English

- Independent wallpapers, quality and fit mode per monitor. Fill preserves proportions; fit retains the whole image with borders.
- Quality menus distinguish the selected format from the active desktop format. Apply a downloaded quality explicitly; the active combination is labeled “Current wallpaper”.
- Consistent nine-frame previews. Official scenes and community videos share discovery; featured community works require server-side curation authority.
- Complete Evening living room packs: 720P24, 1080P24 and 1080P60. Its 28 clips follow defined random successor paths with short transitions. No public 4K downloads.
- Fixes for Windows 11 desktop attachment, mixed-DPI monitor seams and missing final-frame callbacks during transitions.
- All three website languages reflect current capabilities. Signed-in names display across pages, with logout and cross-tab updates. New users register and verify through Aveniqa.
- Windows ZIP approximately 1.95 MiB. Videos are downloaded separately; no bundled Chromium, Node.js or FFmpeg.

## 日本語

- モニターごとに壁紙・画質・表示方式を設定。縦横比を保った全画面表示と、余白付きの全体表示を選べます。
- 画質の選択とデスクトップで使用中の画質を区別。選択後に「壁紙に設定」で適用し、使用中の組み合わせには専用ラベルを表示します。
- 9コマのプレビューを統一。公式テーマとコミュニティ作品を同じマーケットに掲載し、公式おすすめは権限を持つ管理者が選びます。
- 夜のリビングは720P24・1080P24・1080P60の完全なテーマを提供。28本の動画を指定された接続先から選び、短いトランジションで切り替えます。4Kは一般配信していません。
- Windows 11のデスクトップ表示、異なるDPIのモニター境界、末尾フレームのコールバック欠落への対処を改善しました。
- 公式サイト3言語の説明を更新。ログイン後の名前を各ページに表示し、ログアウトとタブ間の状態を同期。初回登録・認証はAveniqaで行います。
- Windows ZIPは約1.95 MiB。動画は個別ダウンロード。Chromium・Node.js・FFmpegは同梱しません。

## Validation and scope

The public beta requires Windows 10/11 x64 and system WebView2. It remains unsigned. No automatic conversion, payments, automatic updates, AI chat or live character interaction is included. The male character shown in promotional artwork has no released video yet.

Root and client TypeScript checks and all 51 Node tests pass. Website account regression checks use fixture sessions across 18 localized pages, including expired sessions, cross-tab logout, stale responses and nickname escaping. Anonymous registration-entry navigation is verified separately; a fixture is not proof of a person's completed identity-provider registration, consent or desktop pairing.

Prior Windows checks used a mixed-DPI pair of monitors and included 4K24 plus 1080P60 playback with 15 and 14 transitions over 180 seconds without player faults or stalls. These are limited observations, not a guarantee of zero dropped frames or compatibility with all hardware. Physical hot-plug, sleep and Explorer restart coverage remains incomplete.
