# 栞 (Shiori)

タブ（＝場所）ではなく、**「行為の途中」** を管理する macOS / Windows / Linux 向けブラウザ。

全ページの読みかけ状態を自動で保存し、次に開いたときは続きから読めます。

---

## ダウンロード

[**Releases**](https://github.com/WaveARGZ/shiori/releases) から最新版をダウンロードできます。

| OS | ファイル |
|---|---|
| macOS (Apple Silicon) | `Shiori-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Shiori-<version>-mac-x64.dmg` |
| Windows (installer) | `Shiori-Setup-<version>-x64.exe` |
| Windows (portable) | `Shiori-Portable-<version>-x64.exe` |
| Linux (AppImage) | `Shiori-<version>-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `Shiori-<version>-amd64.deb` |

**未署名ビルドのため初回起動時に警告が出ます。**

- **macOS**: Gatekeeper にブロックされたら「[未署名アプリの開き方](#️-未署名アプリの開き方)」参照
- **Windows**: SmartScreen の「WindowsによってPCが保護されました」→ **詳細情報** → **実行** で起動
- **Linux (AppImage)**: `chmod +x Shiori-*.AppImage` して実行。`.deb` は `sudo apt install ./Shiori-*.deb`

---

## 5つの機能

| | |
|---|---|
| **ブラウザシェル** | URLバー、戻る/進む/リロード、Arc/Zen 風の縦型サイドバー（レーン＋ページ）、macOS ネイティブの半透明ガラス UI |
| **AIクイックアクセス** | ChatGPT / Gemini / Claude / Perplexity をワンクリックで右サイドパネルに表示。会話とログインはパネルを閉じても保持。エージェント機能は**あえて非搭載** |
| **ユニバーサル栞** | 全ページのスクロール位置と読了率を自動保存し、再訪問時に自動復元。起動画面に「続きから読む」リスト |
| **コンテキスト・レーン** | タブの代わりに「研究」「娯楽」等のレーン。切替で開いてるページ群とスクロール状態が丸ごと入れ替わる |
| **出典つきクリップボード** | ページ内コピー時にURL/タイトル/日時を自動付与してサイドパネルに蓄積。「Markdown引用でコピー」付き |

---

## 起動手順

### 1. 開発モードで起動する

```bash
npm install
npm start          # ビルドして Electron を起動
```

その他のコマンド:

```bash
npm run typecheck  # 型チェックのみ
npm run build      # dist-electron/ にビルド
npm run smoke      # E2Eスモークテスト（後述）
npm run dist       # dist/ に .dmg と .zip を作成
```

### 2. .dmg からインストールする

```bash
npm run dist
open dist/Shiori-0.1.0-mac-arm64.dmg
```

開いた .dmg の中の **Shiori.app** を **Applications** フォルダへドラッグしてください。

---

## ⚠️ 未署名アプリの開き方

このアプリは **コード署名も公証（notarization）もされていません**
（`mac.identity: null` の未署名ビルド）。

そのため初回起動時に macOS Gatekeeper が
**「"Shiori"は壊れているため開けません。ゴミ箱に入れる必要があります。」**
または **「開発元を確認できないため開けません」**
と表示してブロックします。**アプリが壊れているわけではありません。**

以下のどちらかの方法で開いてください。

### 方法A: 右クリック →「開く」

1. Finder で **Shiori.app** を **右クリック**（または control + クリック）
2. メニューから **「開く」** を選択
3. 警告ダイアログの **「開く」** ボタンを押す

一度許可すれば、次回以降は普通にダブルクリックで起動できます。

> **メモ**: 必ず右クリックから開いてください。ダブルクリックでは
> 「開く」ボタンの無い警告が出るだけで起動できません。

### 方法B: xattr で隔離属性を消す

方法Aで「壊れているため開けません」と出る場合（ダウンロードした
.dmg に付く `com.apple.quarantine` 属性が原因）は、隔離属性を削除します。

```bash
xattr -cr /Applications/Shiori.app
```

その後、通常どおりダブルクリックで起動できます。

> `-c` は全属性を消去、`-r` はバンドル内を再帰的に処理します。
> 中身を信頼できるアプリにのみ実行してください。

### 参考: システム設定から許可する

上記でも開けない場合は、一度起動を試した直後に
**システム設定 → プライバシーとセキュリティ** を開き、
下部の **「"Shiori"は開発元を確認できないため…」** の横の
**「このまま開く」** を押します。

---

## 使い方

| 操作 | 内容 |
|---|---|
| **URLバー** | URL を入力すると移動。URLでなければ**栞独自の検索ページ**で検索します（検索エンジンの企業名・ロゴは一切出ません） |
| **栞ボタン / ⌘T** | 「続きから読む」ホーム画面を表示 |
| **レーン**（サイドバー上段） | クリックで切替、**ダブルクリックで名前変更**、`＋` で追加、`×` で削除。ページをここへ**ドラッグ**すると、そのレーンへ移動 |
| **ページ**（サイドバー下段） | クリックで切替、`×` で閉じる。ファビコンと読了率の下線つき。**ドラッグでレーン間の移動・同一レーン内の並べ替え**ができます（スクロール位置は保持したまま） |
| **AIボタン**（URLバー右） | ChatGPT / Gemini / Claude / Perplexity を右パネルに表示。もう一度押すと閉じる |
| **AIパネル** | 上部タブでサービス切替、`↗` でページとして開く、左端をドラッグで幅変更 |
| **❝ボタン** | クリップパネルの開閉（コピーすると自動で開きます。AIパネル表示中はバッジのみ） |

### 検索について

- URLバーに URL 以外を入力すると、**栞の検索ページ**が開きます。裏側では
  無料・APIキー不要の検索ソース（DuckDuckGo の HTML 版）を使っていますが、
  **画面には検索エンジンの企業名もロゴも一切出しません**。表示されるのは
  各結果サイトのドメインだけです。
- 結果をクリックすると通常のページとして開きます。検索結果は本物のページ
  （`shiori://search`）として履歴に載るので、**`⌘[` / `‹` で結果一覧に戻り、
  `⌘]` / `›` で開いたページに進めます**。
- まれに検索ソース側の bot 対策で結果が取れないことがあります。その場合は
  少し時間をおくか、URL を直接入力してください。
- 検索ソースは `src/main/search.ts` の1定数で差し替えられます。

### AIクイックアクセスについて

- パネルの中身は各サービスの**公式サイトそのもの**です。初回は普段どおりログインしてください（ログイン状態と会話はアプリを再起動しても保持されます）。
- 自動操作・要約などのエージェント機能は搭載していません。「読んでいる横に、いつもの AI がいる」だけの設計です。
- まれに Cloudflare の「人間であることの確認」が表示されることがあります。その場合はパネル内でそのままクリックして通過してください。

### ショートカット

| キー | 動作 |
|---|---|
| `⌘L` | アドレスバーへ移動 |
| `⌘T` | 新しいページ（ホーム画面） |
| `⌘⇧N` | 新しいレーン |
| `⌘R` | 再読み込み |
| `⌘[` / `⌘]` | 戻る / 進む |
| `⌘⇧A` | AIパネルを開閉（最後に使ったサービス） |
| `⌥⌘1`〜`⌥⌘4` | ChatGPT / Gemini / Claude / Perplexity を直接開く |
| `⌘⇧B` | サイドバーを表示/隠す |

### 読了率について

- ページ最下部まで到達で 100% です。
- 1画面に収まるページは、定義上つねに 100% として扱います。
- 表示される読了率は **到達した最大値** です。上に戻しても下がりません。
- 栞は URL 単位で、**フラグメント（`#...`）を無視**して記録します。
  同じ記事内の見出しジャンプは1つの読書位置を共有します。

---

## 動作確認

```bash
npm run smoke
```

実際のアプリをローカルの HTTP サーバに対して起動し、UI と同じ IPC 経由で
操作して、実ストアに対して検証します（ネットワークには出ません）。

- `smoke:fresh` — 33項目。スクロール保存/復元、コピー捕捉、レーン切替、AIパネル、ページのレーン間移動、検索（解析・企業名非表示・**戻る/進む**）、ホームUIのスタイル欠落検知など
- `smoke:restart` — 8項目。**アプリを再起動して**レーン/ページ/栞/クリップの復元を検証

パッケージ済みの .app に対しても実行できます（asar 内の preload 解決の確認）:

```bash
SHIORI_SMOKE=1 dist/mac-arm64/Shiori.app/Contents/MacOS/Shiori
```

---

## 技術構成

- **Electron 43** + **TypeScript 5.9**（バンドラなし）
- ページ表示は **WebContentsView**（`BrowserView` / `<webview>` は不使用）
- AIパネルも同じ **WebContentsView**（サービスごとに1ビュー、パネルを閉じても
  デタッチして生かすので会話が消えません）
- UI は **macOS vibrancy**（`vibrancy: 'sidebar'` + 透明背景）による半透明ガラス。
  `nativeTheme.themeSource = 'light'` でシステム設定によらずライト（明るい）固定
- **Google ログイン対応**: 各ページ/AIビューに CDP（DevTools Protocol）の
  `Network.setUserAgentOverride` で**素の desktop Google Chrome の身元を注入**。
  UA 文字列・client hints（`Sec-CH-UA`）・**`navigator.userAgentData`（JS）**の
  3つすべてを "Google Chrome" に一致させる。Google の「安全でないブラウザ」
  判定は UA だけでなく JS の userAgentData も見るため、ヘッダ書き換えだけでは
  弾かれる。OAuth ポップアップにも同じ身元を適用。これで Gmail・Gemini・
  「Google で続ける」がそのまま通ります
- AIビューの `window.open` は **認証ドメインのみポップアップ許可**
  （accounts.google.com 等。それ以外のリンクはレーンのページとして開く）
- 計測スクリプトは **preload + contextIsolation + IPC**
  （`sandbox: true` の分離ワールドで動作し、ページ側には何も公開しません。
  AIビューには preload を一切注入しません）
- 永続化は **electron-store のみ**（ネイティブモジュールなし）
- ビルドは **electron-builder**（mac / dmg + zip / arm64 / 未署名）
- アプリアイコンはブランドマーク（新芽＋波＋栞リボン、濃紺）。
  `build/icon.icns` を electron-builder が取り込み、開発時は Dock に
  `app.dock.setIcon` で同じアイコンを表示。再生成は
  `npx electron scripts/render-icon.js` → `build/` 内で iconutil

### 設計メモ

- **electron-store は 8.2.0 固定**です。9.0.0 以降は ESM 専用で、
  CommonJS の main プロセスから読めません。
- **レンダラは classic script** として読み込みます。`renderer.ts` に
  トップレベルの `import` を書くと tsc が `export {}` を出力し、
  読み込み時に SyntaxError（＝白い画面）になります。共有型は
  `type X = import('...').X` で取り込んでいます。
  `npm run build` の `check:renderer` がこの規約を機械的に守ります。
- **ページ矩形は CSS が正**です。レンダラが `#page-host`（ページ用）と
  `#ai-stage`（AIパネル用）を実測して main に送り、main が WebContentsView の
  bounds をそれに合わせます。`#page-host` はウィンドウ端から 8px 内側にあり、
  角丸にできないネイティブビューがウィンドウの丸角に被らないようにしています。
- **レーン切替でビューは破棄しません**。デタッチして生かしておくため、
  戻したときにリロードなしでスクロール位置がそのまま残ります。

### データの保存先

```
~/Library/Application Support/shiori/shiori.json
```

削除すればレーン・栞・クリップはすべて初期化されます。

---

## 制限事項

- **arm64（Apple Silicon）専用**ビルドです。Intel Mac 用には
  `electron-builder.yml` の `arch` に `x64` を追加してください。
- 未署名・未公証のため、配布には上記の手順が必要です。
- AIサイト側の bot 対策（Cloudflare Turnstile）は UA だけでなく実行環境も
  見るため、まれに確認画面が出ます。手動クリックで通過できます。
- Google の判定はまれに UA/client hints 以外（JS フィンガープリント）も
  見ることがあり、その場合でも弾かれる可能性はゼロではありません。栞は
  UA・client hints の両面で desktop Chrome に一致させているため、通常の
  ログインはそのまま通ります。
