# PROGRESS

栞 (Shiori) の実装記録。

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | プロジェクト基盤 | ✅ 完了 |
| 1 | ブラウザシェル | ✅ 完了 |
| 2 | ユニバーサル栞 | ✅ 完了 |
| 3 | コンテキスト・レーン | ✅ 完了 |
| 4 | 出典つきクリップボード | ✅ 完了 |
| 5 | .dmg ビルド + ドキュメント | ✅ 完了 |
| 6 | AIクイックアクセス + デザイン刷新 | ✅ 完了 |

**完了条件**: すべて達成（`npm run dist` 成功 / 型・ビルドエラー 0 /
`open` でクラッシュせず起動 / README・PROGRESS 記載済み）。

---

## Phase 0 — プロジェクト基盤

環境: macOS 26.5.2, **arm64**（`uname -m` で確認）, Node 22.12.0。

構成: `src/main`（メイン）, `src/preload`（chrome用/ページ用）,
`src/renderer`（UI）, `src/shared`（型のみ）。バンドラなし、tsc 2構成。

### 技術判断

- **electron-store は 8.2.0 に固定**。最新は 11.0.2 だが `type: module`
  （ESM専用）で、CommonJS の main プロセスから `require` できない。
  「一番枯れた選択肢」の指示どおり、CJS 最終版の 8.2.0 を採用。
- **TypeScript 5.9.3**。7.0.2 は出たばかりのため見送り。
- **バンドラを入れない**。Vite/webpack を足すより、tsc 2つと
  15行のコピースクリプトのほうが壊れる箇所が少ない。
- **ページ矩形は CSS を正とする**。定数を CSS と main に二重管理せず、
  レンダラが `#stage` を実測して main に送る方式にした。

---

## Phase 1 — ブラウザシェル

`BrowserWindow`（chrome UI）+ 子として `WebContentsView`（ページ）。
指示どおり `BrowserView` と `<webview>` は不使用。

- URLバー: URL 判定に失敗した入力は Google 検索へ
- 戻る/進む/リロード（読込中は停止ボタンに変化）
- レーンバー + ページバー
- Edit メニューを明示的に定義（macOS では Edit メニューが無いと
  URLバーで ⌘C/⌘V が効かない）
- `titleBarStyle: 'hiddenInset'` + トラフィックライト分の余白

---

## Phase 2 — ユニバーサル栞

ページ用 preload（`sandbox: true` の分離ワールド）でスクロールを計測し、
IPC で main に送信。ページ側には `contextBridge` で何も公開していないため、
サイトからは計測の存在が見えず、改竄もできない。

- 送信は 250ms スロットル
- 保存は electron-store への書き込みが同期＆全書き換えのため、
  メモリ上に持って **1秒デバウンスでフラッシュ**（終了時は即時）
- 読了率 = `scrollY / (docHeight - viewport)`。1画面に収まるページは 100%
- 表示は **到達最大値**（`maxProgress`）
- 栞のキーは **フラグメントを除去**した正規化 URL

### 復元は「レイアウトとの競争」

画像・フォント・ハイドレーションで文書高が後から伸びるため、1回
`scrollTo` するだけでは足りない。**減衰スケジュール**（0〜4200ms の12回）で
再適用し、ユーザーが操作（wheel/keydown/touch/mousedown）したら即座に中断する。

復元中はスクロール報告を**抑止**する。復元途中の文書はまだ短く、
`scrollY` が小さい値にクランプされるため、報告すると復元先そのものを
上書きしてしまう。

### 落とし穴: electron-store のドットキー

electron-store はキーの `.` をネストパスとして解釈する。URL はドットだらけ
なので `store.get('bookmarks.https://…')` は壊れる。**bookmarks は常に
オブジェクト丸ごと** read/write している。

### 修正: Chromium 標準のスクロール復元との競合

スモーク実行7回中1回、リロード後の復元位置が 2400 ではなく 3802 に
ドリフトした。Chromium 自身がリロード時にスクロールを復元するため、
同じ `scrollTop` を2つの機構が奪い合っていた。preload で
`history.scrollRestoration = 'manual'` にして**復元の主導権を栞へ一本化**。

> 注: 元のドリフトは再現できていないため、これが原因だと断定はできない。
> ただし競合自体は実在し、それは解消した。あわせてスモークの判定を
> `> 2000` から **`|scrollY - 2400| <= 50`** に厳格化したので、
> 再発すれば緩い判定に隠れず必ず落ちる。修正後は 6/6 で正確に 2400。

---

## Phase 3 — コンテキスト・レーン

レーン = `{ id, name, color, pages[], activePageId }`。

- **ビューはレーン切替で破棄せず、デタッチして生かす**。だから戻したとき
  リロードなしでスクロール位置が丸ごと復元する（＝「丸ごと入れ替わる」）
- ビューは**遅延生成**（初めてアクティブになった時のみ）。再起動直後に
  全レーンの全ページを読み込んで固まる、という事態を避ける
- 再起動後はレーン/ページ構造をストアから復元し、ビューは触った時に
  実体化してスクロールを栞から復元する
- `activePageId: null` は「ホーム画面表示中」を意味する
- レーンは常に1つ以上残す（最後の1つは削除不可）

---

## Phase 4 — 出典つきクリップボード

ページ用 preload が `copy` イベントを**キャプチャフェーズ**で監視
（イベントを握り潰すサイトでも取得できる）。選択テキストに URL /
タイトル / 日時を付けて保存し、サイドパネルに積む。

- コピー時にパネルを自動で開く（見えないクリップは機能として成立しない）
- 「Markdown引用でコピー」= blockquote + 出典リンク + 日時
- 「全部コピー」で全クリップを一括 Markdown 化
- 上限 500 件

**セキュリティ**: タイトル・URL・本文はすべてページ由来＝攻撃者が制御できる
文字列。レンダラでは `innerHTML` を一切使わず `textContent` で構築している。

---

## Phase 5 — .dmg ビルド + ドキュメント

`npm run dist` → `dist/Shiori-0.1.0-arm64.dmg` + `.zip`（各 114MB）。

- ターゲット: mac / dmg + zip / **arm64**（`uname -m` の結果に一致）
- `mac.identity: null` で未署名。electron-builder のログでも
  `skipped macOS code signing reason=identity explicitly is set to null` を確認
- `npmRebuild: false`（ネイティブモジュールが無いので不要）
- 型エラー・ビルドエラー **0**
- `open dist/mac-arm64/Shiori.app` で起動しクラッシュしないことを確認

### 落とし穴: レンダラの `export {}`

初回ビルドで `renderer.js` の末尾に tsc が `export {};` を出力していた。
classic script では SyntaxError になり、**ビルドは通るのに画面が真っ白**
という最悪の壊れ方をする。型だけの `import type` でもファイルは module
と判定されるのが原因。

対策として共有型は `type X = import('...').X`（型クエリ）で取り込み、
トップレベル import を全廃。さらに `scripts/check-renderer.mjs` を
ビルドに組み込み、ESM 構文が混入したら**ビルドを落とす**ようにした。

---

## 検証方法

UI が絡む機能は「起動してクラッシュしない」では何も確認できない
（真っ白な画面でもプロセスは生き続ける）。この環境では `screencapture` が
使えず目視もできないため、**アプリ自身を動かして実ストアに対して検証する
E2Eスモークテスト**を用意した（`src/main/smoke.ts`、`SHIORI_SMOKE` 未設定時は不活性）。

ローカル HTTP サーバで縦長ページを配信し（ネットワークには出ない）、
UI と同じ IPC 経由で操作する。

```
npm run smoke        # fresh 33項目 + restart 8項目 = 41項目
```

**41/41 パス**（開発ビルドで確認。Phase 5 時点ではパッケージ済み .app でも検証済み）。

> 教訓: 検索オーバーレイの CSS をコメント区間で一括削除した際、同じ区間に
> あったホーム画面のスタイル（`#home-inner` / AIカード等）を巻き込んで消し、
> ホームが素の HTML 見た目に崩れた。スクショ検証を「変更した画面」だけで
> 済ませたのが敗因。以後、CSS の一括削除後は全画面を撮り直す。加えて
> `.home-ai-card` の computed style を検証するスモーク項目を追加し、
> スタイル欠落を機械検知できるようにした。

再起動復元は、書き込んだ本人のプロセス内では検証できないため、
**2回目の起動**（`smoke:restart`）で確認している。このとき復元される URL は
前回のループバックポートで既に死んでいるが、それは意図的
—— レーンとページがネットワークではなく**ストアから**復元されることの証明になる。

主要な検証項目:

- preload ブリッジの公開 / ホーム画面の初期表示
- WebContentsView でのページ読み込みとタイトル取得
- スクロール位置の保存（`scrollY=2400`）と読了率の算出
- **リロード後の復元**（`|scrollY - 2400| <= 50`）
- **レーン往復後のスクロール保持（リロードなし）**
- コピーの捕捉と出典（URL/タイトル）の付与
- レーン切替でページ群が入れ替わること
- **AIパネル**のビュー生成 / 状態同期 / サービス切替でのビュー温存 / ページ昇格
- **再起動後**のレーン名・ページ・栞・クリップの復元

### 既知の弱点

- スモークは自作の静的ページのみを対象にしている。実際の SPA や遅延読込の
  重いサイトでの復元精度は、この検証では担保できていない。
- 復元スケジュールは最長 4.2 秒。それより遅くレイアウトが伸びるページでは
  復元位置がずれる余地がある。

---

## Phase 6 — AIクイックアクセス + デザイン刷新

方針: **エージェントは作らない**。ChatGPT / Gemini / Claude / Perplexity の
公式サイトを「ワンクリックで隣に出す」ことだけを設計目標にした
（2025〜26年のAIブラウザ調査で、エージェント機能はプロンプトインジェクション
未解決・Atlas撤退という結論だったため）。

### AIサイドパネル

- サービスごとに 1 つの WebContentsView。パネルを閉じても**デタッチして
  生かす**ので、会話スレッドがそのまま残る（レーンのビュー温存と同じ思想）
- URLバー右の AIドック（4ボタン）/ ホーム画面のカード / `⌥⌘1〜4` /
  パネル内タブ、どこからでも 1 アクションで開く
- `↗` で「ページとして昇格」— 現在の会話 URL をレーンのページにして
  パネルを閉じる
- クリップパネルとは右側を排他共有。AIパネル表示中のコピーは
  パネルを奪わずバッジ通知のみ

### 埋め込みの落とし穴（事前調査で判明、すべて対処済み）

- **Google ログインは UA で遮断される**（"このブラウザまたはアプリは安全で
  ない可能性があります"）。`app.userAgentFallback` から `Electron/x.y` と
  アプリ名トークンを除去し、素の Chrome UA にして回避（Ferdium PR #2360 と
  同じ手法。UA は 1 バイトでも崩れると弾かれるため、置換のみで再構築しない）
- **OAuth ポップアップを全否定するとログインが死ぬ**。`setWindowOpenHandler`
  で accounts.google.com / appleid.apple.com / auth.openai.com 等の認証
  ドメインだけ `allow`（sandbox 付き・preload なしの素窓）。それ以外の
  window.open はレーンのページに変換
- **Chromium は Cookie を遅延書き込みする**。ログイン直後に終了すると
  セッションが消えるため、`before-quit` で `cookies.flushStore()`
- Cloudflare Turnstile は UA 以外もフィンガープリントするため完全回避は
  不可能（既知の制限として README に明記。手動クリックで通過可能）

### デザイン刷新（Arc / Zen 系）

- レーンバー＋ページバーを廃止し、**左サイドバー**（縦タブ）へ。
  ページ行はファビコン（`page-favicon-updated` を PageRef に保存）＋
  読了率下線つき。`⌘⇧B` で開閉
- **macOS vibrancy**: `vibrancy: 'sidebar'` + `backgroundColor: '#00000000'`
  + `visualEffectState: 'active'`。`transparent: true` は角丸破壊と
  ちらつきの既知バグがあるため**使わない**。`nativeTheme.themeSource='light'`
  でシステム設定によらず素材をライト（明るい）固定。CSS は全色を CSS 変数
  （`:root`）に集約し、ダーク前提のハードコードは `--ring-track` / `--ring-hole`
  / `--input-bg` / `--on-accent` 等に変数化して差し替え可能にした
- **WebContentsView は角丸にできない**（electron#42288）。ページビューを
  ウィンドウ端から 8px 内側（`#page-host`）に置き、角はクロム側が持つ
- スモークの DOM 契約（`#lanes .chip` / `#pages .chip` / `#home` /
  `#home-list .read-row`）は**維持**。バーからサイドバーへの移設でも
  既存項目は無改変で通る

### ページのドラッグ&ドロップ（追加）

- ページ行を HTML5 drag&drop で `draggable` に。**レーン行へドロップ＝移動**、
  **ページ行の上下半分へドロップ＝並べ替え**（挿入位置は青い線で表示）
- ビューは pageId をキーに管理しているため、レーンをまたいでも
  WebContentsView とスクロール位置はそのまま乗り移る（`movePage`）
- 挿入位置は index ではなく **`beforePageId`（ID基準）**で送る。元レーンからの
  削除で index がずれても壊れないため
- サイドバーは `-webkit-app-region: drag`（ウィンドウ移動領域）だが、行は
  `button`＝`no-drag` なので HTML5 drag が成立する
- スモークに move-page 2項目を追加。移動→検証→元に戻すことで restart 期待
  （研究レーンに1ページ）を保つ

### 栞独自の検索ページ（Google を使わない）

要望: 「Google から検索するのが嫌、企業名を出さないでほしい、無料なら何でも」。

- URLバーの非URL入力を、従来の `https://www.google.com/search?q=…` へのリダイレクト
  から、**アプリ内の栞検索ページ**へ切り替え（`url.ts` の `classifyInput`）
- データ元は無料・キー不要の **DuckDuckGo HTML 版**。ただし取得は
  `net.fetch`（Chromium ネットワークスタック）で行い、**生HTMLをレンダラに渡して
  `DOMParser` で解析**（スクリプトは実行されず、text と href だけ読む）。
  結果は栞のカードとして再描画するので**検索エンジンのロゴ・企業名は一切出ない**
- **検索結果は `shiori://search?q=…` の実ページ**（カスタムプロトコル、
  `registerSchemesAsPrivileged` + `protocol.handle`）。当初はクロム側の
  オーバーレイで実装したが、**ページ履歴の外に居るため結果→ページ→「戻る」が
  効かない**ことが判明し、実ページ方式に刷新。結果ページが WebContentsView の
  ネイティブ履歴に載るので、`‹ ›` が「結果 ⇄ 開いたページ」を普通に行き来する
- 結果ページは main 側で生成する**スクリプト禁止（CSP）の静的HTML**。
  解析も main（正規表現ベース、`result__a` / `result__snippet` / `result__url`）。
  ファビコンは `<object>` フォールバック（JS なしで頭文字チップに退避）。
  URLバーには `shiori://…` ではなく**検索語を表示**（renderer の `displayUrl`）
- `SHIORI_SEARCH_URL`（開発時のみ有効）で取得先を差し替え可能。スモークは
  ループバックで**擬似DDG HTMLを配信し、取得→解析→描画の全経路**を検証
  （結果2件・表示・**企業名が出ないこと**をアサート）
- 結果画面はカードデザイン: 上部にホームと同じ大型検索ボックス（クエリ入り、
  その場で再検索可）、結果は白カード＋影＋ホバーで浮遊＋右矢印スライドイン、
  順次フェードイン。ファビコンは**結果サイト自身の** `/favicon.ico` を直接
  読み（第三者のファビコンAPIは使わない）、失敗時は色相グラデの頭文字チップ。
  落とし穴: `.search-status` の `display:flex` が `[hidden]` の UA ルールを
  上書きして「検索中…」が消えない → `.search-status[hidden]{display:none}` で解消
- サンドボックスの データセンターIP では DDG も SearXNG も bot 対策で弾かれる
  ため、実機（住宅IP）前提。失敗時は「時間をおくか URL を直接入力」を案内

### アースカラー全面刷新 + 左レール + ステータスバー（追加）

ユーザー提供のモックアップ（温かいベージュ×ブラウン、左に縦アイコンレール、
下部ステータスバー、検索ページのタブ＋AI概要）に合わせて全面リデザイン。

- **配色は `:root` の CSS 変数を差し替えるだけで全面移行**（ネイビー/水色 →
  クリーム＋ウォルナット茶）。アプリアイコン（新芽マーク）は指示どおり不変で、
  ブランドタイルのみネイビーを維持
- **左の縦アイコンレール**（espresso 色）: ブランド（ホーム）/ サイドバー /
  クリップ / AI / 履歴、最下部に表示切替。トップバーのサイドバーボタンは
  レールへ移設（id は保持し renderer の参照を壊さない）
- **下部ステータスバー**: ● 接続済み（`navigator.onLine`）· N lanes · M pages ·
  読了 X%。online/offline イベントで更新
- **英字ラベルはモノスペース**（`--mono`）: Lanes / Pages / new page / URL /
  ステータス / レーン数。レーンのページ数は **2桁ゼロ埋め**（04 / 01 / 00）
- **検索ページ刷新**: `● browser` ロゴ＋検索欄の横並び、タブ
  （すべて/画像/動画/ニュース、非「すべて」はキーワードを足して再検索する
  実リンク＝死んだ操作なし）、**AI OVERVIEW カード**、パンくず付き結果
  （host › path）。落とし穴: AI概要はサーバレンダリングのため取得が結果表示を
  ブロックしうる → タイムアウト 1.5s に短縮し、取れなければカードを省略
- **AI OVERVIEW は LLM を呼ばない**。DuckDuckGo の Instant Answer（無料・
  ゼロクリック要約）を表示するだけ（`fetchAbstract`）。エージェント不要方針を
  守りつつモックアップの見た目を満たす。開発時は `SHIORI_ABSTRACT` で差し替え
- スモークに検索タブ数・AI概要カード・パンくずホスト解析の検証を追加

### Google ログイン対応の強化（追加）

「とにかく Google にログインできるように」との要望。栞は Web ブラウザなので
ケース1（アプリ内で Google サービスにログイン）＝ UA 方式が正解
（OAuth/PKCE は栞自身のアカウント機能＝同期用で、今回は対象外）。

- 以前は UA から `Electron` / アプリ名トークンを**除去**していたが、除去だと
  二重スペースや形状崩れのリスクがある。**素の macOS Chrome UA を組み立て直す**
  方式に変更（`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Chrome/<同梱
  Chromium版> Safari/537.36`）。バージョンは `process.versions.chrome` から
  取るので更新に追従し、client hints とも一致
- **client hints も一致させる**: Electron は既定でブランド "Chromium" を送り、
  Google はこれを非 Chrome と判定する。`webRequest.onBeforeSendHeaders` で
  `Sec-CH-UA` に `"Google Chrome"` を含めて書き換え、UA と client hints の
  身元を揃えた（accounts.google.com の secure-browser チェックはここを見る）
- permission handler は**あえて追加しない**。Electron 既定は寛容で、制限的な
  handler を足すと AI サイトのマイク/クリップボード等を壊すため
- システムブラウザ + OAuth 方式は不採用。栞内の webview にセッションを残せず
  「アプリ内で Gmail を見る」目的を満たさないため
- スモークに「UA が素の desktop Chrome」「client hints が Google Chrome を
  名乗る」の 2 項目を追加（ループバックへの実リクエストのヘッダで検証）

**追記（まだ弾かれる件の解決）**: UA 文字列とヘッダだけでは Google が
`navigator.userAgentData`（JS から見えるブランド）を読んで組み込みブラウザ
判定するため弾かれた。**CDP の `Network.setUserAgentOverride` に
`userAgentMetadata`（brands / fullVersionList / platform 等）を渡す**ことで、
UA・Sec-CH-UA・navigator.userAgentData の 3 面すべてを desktop Google Chrome
に統一（`applyChromeIdentity`、`browser.ts`）。全ページ/AIビュー生成時と
OAuth ポップアップ（`did-create-window`）に適用。スモークに
「`navigator.userAgentData` が Google Chrome を報告する」検証を追加。
`app.userAgentFallback` と `onBeforeSendHeaders` は保険として併存。

**さらに追記**: CDP は `loadURL` の後に fire-and-forget で適用する（loadURL が
レンダラープロセスを起こし、CDP コマンドはその後に解決される）。`await` して
から load すると「CDPはプロセス待ち・プロセスはload待ち」でデッドロックする。
また CDP アタッチが `navigator.webdriver` を true にしないことをスモークで確認
（true になると Google が自動操作ブラウザとして弾くため）。結果、UA 文字列・
`Sec-CH-UA`・`navigator.userAgentData`・`navigator.webdriver=false` の 4 点が
すべて desktop Google Chrome に一致。OAuth ポップアップにも `did-create-window`
で同じ身元を適用。

**症状「メール入力→次へで弾かれる」への対処**: サインイン画面は出るが
identifier 送信後に弾かれるのは、Google が2段階目で **JS の環境シグナル**
（`window.chrome` の中身・`navigator.plugins`・`navigator.webdriver` 等）を
検査して埋め込みブラウザを検出するため。CDP `Page.addScriptToEvaluateOnNew
Document` で **document-start に stealth スクリプトを注入**し、`window.chrome`
（runtime/loadTimes/csi/app）・非空の `navigator.plugins`・`navigator.languages`
・`webdriver=false` を補完（`STEALTH_JS`, `browser.ts`）。これで UA・hints・
userAgentData・JS環境のすべてが desktop Chrome に一致。スモークに
「リロード後の新規ドキュメントで環境スプーフが効いている」検証を追加。

### 検索のページネーションと画像保存（追加）

- **結果件数を増やす**: 1ページにつき DuckDuckGo の複数オフセット
  （`&s=0/20/40`）を並列取得して結合・URL重複除去（`dedupeResults`）。
  さらに検索ページ下部に **「前のページ / 次のページ」リンク**
  （`shiori://search?q=…&p=N`）。CSP でスクリプト禁止のため、ページ送りは
  リンク（=実ページ履歴に載るので ‹/› とも整合）で実装
- **画像の保存**: 全ページ/検索ビューに右クリックの
  **ネイティブコンテキストメニュー**（`context-menu`）を追加。画像上では
  「画像を保存…」（`wc.downloadURL`）「画像をコピー」、リンク上では
  「新しいページで開く / コピー」、テキストは cut/copy/paste。画像タブの
  サムネイルもこれで保存可能
- スモークに「次ページリンクが存在する」検証を追加

### 動画フルスクリーン（追加）

YouTube 等で動画を全画面にすると、ページの WebContentsView が `#page-host`
の枠に閉じ込められ、上下左のバーが見えてしまう問題を修正。

- ページ WebContents の `enter-html-full-screen` / `leave-html-full-screen`
  を監視し、`shiori:fullscreen` をレンダラへ送信
- レンダラは `body.fullscreen` を付与 → **クロム（トップバー/レール/サイドバー/
  ステータス/パネル）を全て隠し、`#page-host` の inset を 0** に。既存の
  rect 追従でビューがウィンドウ全体を覆う
- あわせて **ウィンドウを OS フルスクリーン**に（`win.setFullScreen(true)`）。
  ただし自分が入れた時だけ解除する（ユーザーが自分で入れた全画面を奪わない）
- スモークは `body.fullscreen` の CSS 契約（バー非表示・inset 0）を検証

### アイコン刷新（Outline / 栞リボン）

ユーザー提供の新アイコン（クリーム地の角丸タイル＋濃茶のアウトライン枠＋
濃茶の栞リボン、文字なし）に差し替え。

- `scripts/render-icon.js` を新デザインで書き直し、`build/icon.icns` を再生成
  （文字は小サイズで潰れるため省略＝ユーザー許可済み）
- ブランドマークを **ソリッドな栞リボン**に統一: `#i-logo`（`fill=currentColor`）
  / `search.ts` の `LOGO_SVG` / アプリアイコンで**同一パス**を共有
- UI 内タイル（トップバー無し・レール上部・ホーム大・検索ロゴ）を
  **クリーム地＋espresso アウトライン（`inset box-shadow`）＋espresso リボン**に
  （旧ネイビータイルを廃止、`--brand-ink` / `--brand-paper` に集約）

### ブランドアイコンとネイビー統一（旧・置き換え済み）

ユーザー提供のアイコン（濃紺角丸＋白ラインアートの新芽・波・栞リボン＋
SHIORI しおり）に合わせてブランドを統一。

- 貼り付け画像の実ファイルは取得できないため、**同じ構図を SVG/HTML で再現**し、
  透明ウィンドウの `capturePage` で 2048px PNG（アルファ付き）を生成
  （`scripts/render-icon.js`）。`sips` + `iconutil` で `build/icon.icns` 化し、
  electron-builder（`mac.icon`）と開発時 Dock（`app.dock.setIcon`）に配線
- 同じマークのパスを `index.html` の `<symbol id="i-logo">` と
  `search.ts` の `LOGO_SVG` に共有（3箇所同期、コメントで明記）。
  トップバーの栞ボタン＝**ネイビータイル＋栞ワードマーク**、ホームヒーロー＝
  大型タイル、検索ページのマークもタイル化
- 配色: アクセントを水色 `#3f80cc` → **ネイビーインディゴ `#3a5aa5`**
  （白地でのコントラスト確保）。タイルはアイコンと同じ
  `#212a4c → #1a2138` グラデ。ホーム/検索の背景もネイビー寄りの寒色に。
  可読性最優先で本文色・白カードは維持

### UI 洗練（「ちゃっちさ」対策）

- 選択中のレーン/ページを**白カード＋影＋アクセントレール**（Arc/Safari の
  サイドバー流）に。フラットな薄グレーの連続をやめて階層を出した
- ファビコン欠落時のプレースホルダを、ホスト名から生成した**色相の
  グラデーション**に（灰色四角のベタ塗りが安っぽさの主因だった）
- パネル・ページ枠・ホームカードに `box-shadow` で深度を追加
- 影・サーフェス色は `--surface` / `--shadow-sm|md|lg` に集約

### パネル幅リサイズの罠

ネイティブビューはクロムより上に浮いており、ドラッグ中の mousemove を
食ってしまう。そこでドラッグ開始（`shiori:ai-resize` の `start`）で
**両ビューを一時的にウィンドウから外し**、クロムが全イベントを受けて
幅を追従、`end` で幅を永続化してから再アタッチする方式にした。
renderer 側は `buttons === 0` の mousemove でも確定させ、ビュー外で
ボタンを離した場合の取りこぼしを防ぐ。

### 検証

- スモーク: fresh 24 項目 + restart 8 項目 = **32/32 パス**。AIパネルは
  `SHIORI_AI_URL` でループバックサーバに向け、ビュー生成 / 状態 /
  サービス切替でのビュー温存 / ページ昇格 / 排他をネットワークなしで検証
- `SHIORI_SHOT=1`（新設）: シード済みプロファイルで起動し、chrome を
  `capturePage` で PNG 化してデザインを目視確認できるようにした
  （ホーム / AIパネル / クリップパネルの 3 枚）

## Phase 7 — メモリ最適化 + Windows 対応 + 配布

### ランタイムのメモリ/軽量化（機能は不変）

- **ページビューの LRU 上限**（最重要）: これまで一度アクティブ化した全ページの
  WebContentsView（=レンダラプロセス、1つ 100–300MB）をデタッチ後も無期限に
  保持していた。デタッチ済みビューを 5 枚までとし、超過分は最久未使用から破棄。
  読書位置はユニバーサル栞が保存/復元するので、再アクティブ化で元通り。
  破棄の除外: アクティブページ / 音声再生中 / 内部ページ（shiori://）
- **page-title-updated の同値ガード**: タイトルに時計や未読数を刻むサイトが
  毎秒「全ページ永続化＋サイドバー全再構築」を誘発していたのを、実際に
  変わった時だけに
- **ブックマーク書き込みを後行デバウンスに**: スクロール中毎秒だった全ファイル
  同期書き込みを「静止後 3 秒に 1 回（最大 15 秒でフォールバック）」に
- **非表示ホームの再構築スキップ**: ページ読込のたびに見えない DOM を全再構築
  していたのを、表示に切り替わる瞬間まで遅延（homeDirty）
- **progress tick の軽量化**: 250ms ごとの renderNav 全実行をやめ、進捗
  バッジ 2 箇所のみ更新
- **preload の復元リスナー漏れ修正** + **同値スクロールレポートの送信抑制**
- **CDP Network.enable にバッファ上限**（レスポンスボディの滞留を 1MB に制限）

### Windows 対応（macOS の挙動はバイト同一）

- UA / client hints / userAgentData を **実行 OS の Chrome** として提示
  （Windows では Windows NT 10.0 トークン。ログイン互換の一貫性のため）
- BrowserWindow: win32 は vibrancy なしの単色ウォーム背景＋ネイティブフレーム。
  メニューは mac 専用 role（hide/zoom/front 等）を分岐
- `.traffic-spacer` 非表示（body.not-mac）、ツールチップの ⌘/⌥/⇧ →
  Ctrl+/Alt+/Shift+ 自動置換、フォントスタックに Segoe UI / Yu Gothic UI /
  Cascadia Mono を追加
- `app.setAppUserModelId`（タスクバーのピン留め/通知帰属）
- npm scripts をクロスプラットフォーム化（clean の rm -rf → Node ワンライナー）

### 配布（GitHub Releases）

- electron-builder: mac dmg+zip (arm64/x64)、win NSIS+portable (x64)、
  `compression: maximum`、テスト専用 JS（smoke/shot）をパッケージから除外、
  publish は GitHub draft
- `.github/workflows/release.yml`: `v*` タグ push で macos-latest / windows-latest
  の 2 ジョブが同一 draft リリースへアップロード
- Windows アイコンは build/icon.png（1024px）から electron-builder が
  .ico を自動生成

### 検証

- スモーク: fresh + restart 全パス（メモリ最適化後も 83 項目グリーン）
- mac パッケージ（--dir）を実ビルドし、起動→終了を確認。asar に smoke/shot/
  ソースマップが含まれないことを確認
