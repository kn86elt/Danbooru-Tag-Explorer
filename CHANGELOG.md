# Changelog

## [0.3.0] — 2026-05-11

### Added
- **グリッドビュー: カードサイズ変更スライダー**
  - グリッド表示時にツールバーへ S / M / L の 3 段階スライダーを追加
  - サイズはブラウザの localStorage に保存され、次回起動時も維持される
  - リスト表示中はスライダーを自動的に非表示にする

- **グリッドビュー: カードサイズ別のテキスト表示改善**
  - **S サイズ** (minmax 140px): フォントを 11px に縮小・カード高を詰める。アクションボタンをフロー外 (position: absolute) に退避させ `tag-name` が全幅を使用できるようにする。ホバー時にボタンを半透明 (opacity 0.75) で重ね表示
  - **M サイズ** (minmax 220px): 従来どおり (デフォルト)
  - **L サイズ** (minmax 320px): フォントを 13.5px に拡大。`-webkit-line-clamp: 2` による 2 行折り返し表示で長いタグ名も切れずに読める。日本語訳 (tag-ja) を合わせて表示

### Fixed
- **A1111 拡張: ブラウザキャッシュ問題の解消**
  - `build_index_html()` で `app.js` / `dte_app.css` の URL にファイル mtime をクエリパラメータとして付加するキャッシュバスティングを実装 (`?v=<mtime>`)
  - ファイル更新時に URL が自動で変わるため、A1111 再起動後にブラウザが古いキャッシュを使い続ける問題が解消される
  - `dte_static` ハンドラで JS / CSS レスポンスに `Cache-Control: no-cache, must-revalidate` ヘッダーを付加

---

## [0.2.0] — 2026-05-10

### Added
- **A1111 / reForge 拡張モードの実装**
  - `scripts/danbooru_tag_explorer.py` による FastAPI ルート登録
  - WebUI の Settings タブから タグ CSV / 日本語訳 CSV のパスを設定可能
  - a1111-sd-webui-tagcomplete の `danbooru.csv` を自動借用
  - CSV 専用エンドポイント (`/api/csv/danbooru`, `/api/csv/ja`) で BASE_DIR 外のパスにも対応
  - A1111 モードでのデフォルトライトテーマ設定

### Fixed
- スクロールバグの修正
- A1111 拡張モードの各種バグ修正

---

## [0.1.0] — 2026-05-09

### Added
- 初回リリース
- カテゴリツリーによるタグの階層的探索
- タグ名・日本語名でのインクリメンタル全文検索 (AND 検索対応)
- danbooru Wiki プレビュー表示とリンク機能
- お気に入り・ピン止め (サーバー側 `settings.json` で端末間共有)
- 検索・カテゴリ・スクラッチパッドの閲覧履歴 (localStorage)
- スクラッチパッドへのタグ蓄積とまとめてコピー
- グリッド / リスト表示切り替え
- モバイル・スマートフォン対応レイアウト
- Flask スタンドアローンサーバー (`server.py` / `run.bat` / `run.sh`)
- `tools/build_tag_tree.py` による `tag_tree.json` 再生成スクリプト
