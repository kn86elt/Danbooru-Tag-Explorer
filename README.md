# Danbooru Tag Explorer

Danbooru のタグをカテゴリツリーから探すためのローカルビューアです。

- カテゴリツリーでタグを階層的に探索
- **タグ詳細モーダル**: タグ名・日本語訳・パンくず・post 数・Danbooru Wiki 全文表示（`[[tag]]` リンクをクリックで連鎖表示）
- 各タグの Danbooru Wiki ホバープレビュー表示とリンク機能
- タグ名・日本語名での全文インクリメンタル検索（AND 検索対応）
- お気に入り・ピン止め（複数端末で共有可）
- 検索・カテゴリ・スクラッチパッドの履歴（ブラウザごとに保持）。タイプ別フィルター付き
- スクラッチパッドへのタグ蓄積とコピー（コンマ自動付加オプション付き）
- グリッドビュー: カードサイズ S / M / L の切り替え（文字サイズ・折り返し・日本語表示が自動調整）
- モバイル・スマートフォン対応
- A1111 系 Stable Diffusion WebUI の拡張として動作可能
- **LLM連携(β)**: 対応するローカルLLMが稼働している場合のみ、日本語の自然言語テキストを Danbooru 風タグに変換（Ollama / LM Studio 等）。`/` プレフィックスでフリーモード（LLMに自由に回答させる）にも切り替え可能
- **LLMによる日本語検索の自動翻訳**: 対応LLM稼働中は日本語で検索して結果ゼロの場合、LLM でタグに変換して再検索。複数の候補を列挙して選択可能。候補数コントロール（− ×N + ↺）付き
![スクリーンショット](screenshot.jpg)

## 必要なもの

- **Python 3.9 以上**
- **uv**（推奨）または pip で `flask` をインストール済みの環境

uv を使うと Flask の依存関係を自動で管理します。未導入の場合は次のコマンドでインストールできます。

**Windows (PowerShell):**
```powershell
winget install astral-sh.uv
# または
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**macOS / Linux:**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

uv がない場合は、起動スクリプトが自動で `pip install flask` にフォールバックします。

## 起動方法

### Windows

```bat
run.bat
```

### macOS / Linux

初回のみ実行権限を付与してください。

```bash
chmod +x run.sh
./run.sh
```

起動後、ブラウザが自動で開きます。スマートフォンなど同一 LAN の別端末からは、
起動時にターミナルに表示されるローカル IP アドレスの URL でアクセスできます。

```
  This PC:    http://localhost:8000/
  Other devices: http://192.168.x.x:8000/
```

サーバーを停止するには Ctrl+C を押すか、起動したウィンドウを閉じてください。

## LLM連携(β)

ローカル LLM サーバー（Ollama、LM Studio 等）と連携して、日本語テキストを Danbooru タグに変換できます。

### 対応バックエンド

| バックエンド | デフォルトポート | モデルアンロード |
|---|---|---|
| Ollama | 11434 | ✓ |
| LM Studio | 1234 | ✓ |
| text-generation-webui | 5000 | ✓ |
| KoboldCpp | 5001 | — |
| llama.cpp server | 8080 | — |
| カスタム | 任意 | — |

### 推奨モデル（4B クラス）

日本語→Danbooru タグ変換に適したローカルモデルの例：

| モデル | 日本語精度 | 速度 |
|---|---|---|
| `qwen2.5:3b`（Ollama） | ★★★★☆ | 速い |
| `gemma3:4b`（Ollama） | ★★★★☆ | 速い |
| `phi4-mini:3.8b`（Ollama） | ★★★☆☆ | 速い |

### 設定方法

1. ヘッダー右の **⚙ 設定** ボタンをクリック
2. **LLM設定** セクションでプリセットを選択（接続先・ポートが自動補完されます）
3. **🔄** ボタンでモデル一覧を取得し、使用するモデルを選択
4. **保存**

LLM サーバーがモデルをロード済みの場合は、起動時に自動検出されるため設定なしでも利用できます。

### 使い方

**LLM連携タブ（スクラッチパッド内）:**

1. スクラッチパッドの「LLM連携(β)」タブをクリック
2. 左のテキストエリアに日本語で説明文・メモを入力
3. **→ 変換** ボタンをクリック
4. 右のタグ出力エリアに Danbooru タグが生成される
5. **コピー** でクリップボードにコピー、または手動で編集してから使用

**フリーモード（`/` プレフィックス）:**

- テキスト入力の先頭に `/` を付けると、Danbooru タグ変換を行わず LLM への自由質問として送信される
- タグ以外の用途（モデルのテスト・質問応答など）に利用できる
- フリーモード専用のシステムプロンプトを設定可能（設定モーダル内）

**日本語検索の自動翻訳:**

- 検索バーに日本語を入力して結果がゼロ件の場合、800ms 後に LLM が自動的にタグへ変換して再検索
- 検索ボックス右の **🤖** ボタンで手動発火（結果件数に関わらず強制翻訳）
- AI 翻訳による結果には「🤖 AI翻訳」バッジが表示される

**AI候補チップ:**

- 翻訳後、各コンセプトの候補の組み合わせが検索ボックス下にチップとして一覧表示される
- チップをクリックするとそのクエリで即時再検索（Enter →「一覧表示」にも反映）
- 末尾のチップは元の日本語入力そのものに戻るためのショートカット
- チップ末尾の **− ×N +** で LLM に返させる候補数を 1〜10 の範囲で増減できる（再翻訳が発生）
- **↺** ボタンで同じ候補数のまま再翻訳（ブレインストーミング用途）
- 候補数の設定は `localStorage` に保存され、次回起動時も維持される

### タグ正規化の仕組み

LLM の出力は以下の順序で Danbooru タグに正規化されます：

1. **日本語逆引き**: `ja.csv` に登録された日本語訳をキーに逆引き（例: `頬杖` → `head_rest`）
2. **英語直接解決**: スペースをアンダースコアに変換してタグデータベースで完全一致検索
3. **フォールバック**: 上記で一致しない場合はアンダースコア正規化した英語語句をそのまま使用

## Stable Diffusion WebUI (A1111 / reForge) 拡張としてインストールする

### インストール手順

WebUI の **Extensions** タブ → **Install from URL** に次の URL を入力してインストールします。

```
https://github.com/<your-repo>/danbooru_tag_explorer
```

または `extensions/` フォルダに本リポジトリをフォルダごと配置してください。

```
stable-diffusion-webui/
└── extensions/
    └── danbooru_tag_explorer/   ← このフォルダを置く
        ├── scripts/
        │   └── danbooru_tag_explorer.py
        ├── index.html
        ├── app.js
        └── ...
```

WebUI を再起動すると **DanbooruTagExplorer** タブが追加されます。

> **キャッシュについて**: 拡張の JS / CSS はブラウザにキャッシュされます。ファイルを更新した後は WebUI を再起動してください。起動時にファイルの更新日時をもとにキャッシュバスティング用クエリパラメータ (`?v=<mtime>`) が自動付加されるため、再起動後のブラウザ通常リロードで最新版が読み込まれます。

### danbooru.csv の準備

拡張モードでは起動スクリプト（`run.bat`）が実行されないため、`danbooru.csv` は次のいずれかの方法で用意してください。

1. **[a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) を導入済みの場合**、そのCSVを自動で借用します。追加作業は不要です。
2. **スタンドアロンモードで一度起動する**（`run.bat` / `run.sh`）と `data/danbooru.csv` が自動取得されます。その後 WebUI を再起動してください。
3. **手動配置**: 互換CSVを `data/danbooru.csv` としてコピーしてください。

### タグ・翻訳ファイルのパスを変更する

WebUI の **Settings** → **Danbooru Tag Explorer** セクションで設定できます。

| 項目 | 説明 |
|------|------|
| タグCSVファイルパス | 空欄 = 自動検出（上記の順序）。絶対パスまたは相対パス（拡張フォルダ `danbooru_tag_explorer/` 基準）で指定。 |
| 日本語訳CSVファイルパス | 空欄 = `data/ja.csv`。絶対パスまたは相対パス（拡張フォルダ基準）で指定。 |

設定変更後は **DanbooruTagExplorer** タブをリロード（ブラウザの更新ボタン）してください。WebUI の再起動は不要です。

## ファイル構成

```
danbooru_tag_explorer/
├── index.html          # アプリ本体 (HTML)
├── app.js              # アプリ本体 (JavaScript)
├── dte_app.css         # スタイルシート
├── server.py           # Flask サーバー (静的配信 + REST API)
├── run.bat             # Windows 用起動スクリプト
├── run.sh              # macOS / Linux 用起動スクリプト
├── generate_ja.py      # data/ja.csv サンプル生成スクリプト
├── tools/
│   └── build_tag_tree.py   # tag_tree.json 再生成スクリプト（通常は実行不要）
└── data/
    ├── tag_tree.json       # カテゴリツリーデータ（同梱）
    ├── danbooru.csv        # タグメタデータ（初回起動時に自動取得）
    ├── ja.csv              # 日本語翻訳データ（generate_ja.py で生成）
    └── settings.json       # お気に入り・ピン止め・LLM設定（自動生成）
```

danbooru.csv / ja.csv は互換性のある他のデータと差し替え可能です。
以下のデータが流用できることを確認しています。日本語でのタグ検索性を向上させたい場合は特に導入を推奨します。

- [CIVITAI:tagcomplete用辞書&日本語翻訳辞書 / asugonomi](https://civitai.com/models/2018479/danbooru-tag-complete-csv-tagcompleteand?modelVersionId=2284461)

## データの永続化

| データ             | 保存先                   | 端末間共有 |
|--------------------|--------------------------|-----------|
| お気に入りタグ     | `data/settings.json`     | 共有される |
| ピン止めカテゴリ   | `data/settings.json`     | 共有される |
| LLM設定            | `data/settings.json`     | 共有される |
| AI候補数設定       | ブラウザの localStorage  | 端末ごと  |
| 検索履歴           | ブラウザの localStorage  | 端末ごと  |
| カテゴリ閲覧履歴   | ブラウザの localStorage  | 端末ごと  |
| スクラッチパッド   | ブラウザの localStorage  | 端末ごと  |

お気に入り・ピン止め・LLM設定はサーバー側の `data/settings.json` に保存されるため、
同一サーバーにアクセスする複数端末間で自動的に共有されます。

## 同梱データについて

`data/tag_tree.json` は Danbooru Wiki のタググループページから生成したカテゴリツリーデータです。
タグ名・Wiki ページ URL・カテゴリ階層を含みます。
画像・サムネイル・Wiki 本文全文・投稿データは含みません。
機械的な生成物であり不適当なカテゴリ分けを含む場合があります。

主な参照元:

- Danbooru: https://danbooru.donmai.us/
- tagcomplete 用 CSV: https://github.com/DominikDoom/a1111-sd-webui-tagcomplete
- タグツリー seed: https://github.com/KohakuBlueleaf/danbooru-tag-tree

## tag_tree.json の再生成

通常は再生成不要です。Danbooru 側の分類構造が大きく変わった場合にのみ実行してください。

```bash
python tools/build_tag_tree.py --out data/tag_tree.fixed.json --report data/tag_tree_report.json
```

問題なければ `data/tag_tree.fixed.json` を `data/tag_tree.json` に差し替えます。

## 更新履歴

[CHANGELOG.md](CHANGELOG.md) を参照してください。
