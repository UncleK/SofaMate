<p align="center"><img src="site/assets/social-card.png" alt="SofaMate — お気に入りの姿を、すぐそばに。" width="100%"></p>

<p align="center"><b>デスクトップに、そばにいる温もりを。</b><br>好きなキャラクターをWindowsのデスクトップに。仕事や勉強、ひとりの時間に寄り添う動画壁紙アプリ。</p>

<p align="center"><a href="https://sofamate.aveniqa.com/ja/">公式サイト</a> · <a href="https://sofamate.aveniqa.com/ja/download">Windows版</a> · <a href="https://sofamate.aveniqa.com/ja/market">作品を見つける</a> · <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

## あなたの「好き」を、そばに

![実際のWindowsクライアント](site/assets/client-featured.png)

彼女の優しさも、彼の笑顔も。心ひかれるキャラクターの動画を、いつものデスクトップに。SofaMateは動画を通じて、ひとりの時間に少しの温もりを届けます。

MP4を読み込むと、PC内で9コマのプレビューを自動生成。確認して「壁紙に設定」を選ぶと、デスクトップのアイコンの後ろで再生されます。現在のバージョンはAIチャットやリアルタイムの対話には対応していません。

| コレクション | 自由な操作 | コミュニティ |
| --- | --- | --- |
| ローカル動画とインストール済みテーマを検索。左右の矢印で切り替え。 | パネル内のプレビューとデスクトップの再生は別々に操作。 | ログインして作品を公開。閲覧とダウンロードは登録不要。 |
| 9コマのプレビューはPC内で生成。 | 一時停止・再開・停止・音量をコンパクトなメニューに。 | ダウンロード後はオフラインで利用可能。 |

<table><tr><td width="70%"><img src="site/assets/client-library.png" alt="マイ壁紙"></td><td width="30%"><img src="site/assets/client-controls.png" alt="壁紙の操作メニュー"></td></tr></table>

## 軽量な設計

- **Tauri + システムWebView2。** Chromium、Node.js、FFmpegをクライアントに同梱しません。ZIPは約1.89 MiBです。
- **初期状態はミュート。** 停止するとデスクトッププレイヤーを終了。パネルを閉じても壁紙は再生を続けます。
- **ローカル優先。** 動画の読み込みと再生は登録不要。共有を選ぶまでアップロードされません。
- **Aveniqa共通アカウント。** メール認証コード、Google、GitHubに対応。ブラウザーでログインし、WindowsのDPAPIでアプリの認証情報を保護します。
- **3言語に対応。** 简体中文・English・日本語。公式サイトも各言語の独立したページを用意しています。

## はじめる

1. [Windows ZIPをダウンロード](https://github.com/UncleK/SofaMate/releases/latest/download/SofaMate-Windows-x64.zip)して解凍します。
2. `SofaMate.exe`を開き、「動画を読み込む」からH.264/AACのMP4を選びます。
3. プレビュー後に「壁紙に設定」を選びます。トレイアイコンをダブルクリックするとパネルに戻れます。

Windows 10/11 x64と[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)が必要です。現在はメインモニター、1本最大1 GiBの動画に対応します。公開ベータ版は未署名です。動画は同梱していません。自分の動画、[公式サンプルやコミュニティ作品](https://sofamate.aveniqa.com/ja/market)をご利用ください。

バナー左は「夜のリビング」の実際のキャラクター、右は新キャラクターのイメージです。右のキャラクターの動画は未公開です。

## 開発

デスクトップ版のビルドにはNode.js 24以降、npm、Rust stable、Windows SDK、Visual Studio C++ Build Toolsが必要です。FFmpegは制作・テスト素材用です。

```powershell
npm ci
npm run build
npm run package:public
```

出力先は`release/public/SofaMate/`。公開パッケージにローカルアカウント、制作素材、開発パスは含めません。

```powershell
npm ci --prefix experiments/tauri-client
npm run fixtures
npm run typecheck
npm run typecheck:client
npm test
npm run build:market
```

マーケットは独立したNode.jsサービスです。[デプロイと認証](deploy/README.md)、[パック形式](docs/PACK_FORMAT.md)、[Windows壁紙の動作](docs/WINDOWS_WALLPAPER.md)、[公式サイトの制作](docs/WEBSITE.md)をご覧ください。共通の再生ロジックは`src/core`、デスクトップの入口は`experiments/tauri-client`です。

## 現在の範囲

公開ベータ版です。マルチモニター、動画の自動変換、決済、自動アップデートは未対応です。制作アーカイブ、認証情報、ユーザーの投稿動画はリポジトリに含めません。

質問や再現可能な不具合は[Issues](https://github.com/UncleK/SofaMate/issues)へ。公開投稿にメールアドレス、トークン、個人のファイルパスを含めないでください。[第三者ライセンス表記](THIRD_PARTY_NOTICES.md)もご確認ください。SofaMateのソースとデモアートのライセンスはまだ指定されていません。
