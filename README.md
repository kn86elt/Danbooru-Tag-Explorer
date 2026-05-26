# Danbooru Tag Explorer

A1111 / Reforge / Forge Neo などの WebUI 画面内で Danbooru タグをローカル検索できる拡張機能です。
タグを探してスクラッチパッドやお気に入りに蓄積し、そのままプロンプトに活用できます。
A1111系WEBUIを利用していないユーザーもスタンドアロン動作するDanbooruタグ閲覧用WEBUIとして動作させることができます。
（スタンドアロンとA1111拡張を同時使用する場合はそれぞれ別フォルダへのインストールをおすすめします）

![スクリーンショット](screenshot.jpg)

## 機能

- カテゴリツリーからタグを階層的に探したり、タグ名・日本語名で全文検索できます。表示件数や部分一致・投稿数順の並べ替えなど、Danbooru 本家と比較して自由度の高い検索が可能です
- 表示されたタグに関連する Danbooru Wiki の内容をマウスホバーでプレビューしたり、関連タグを辿ることができます
- スクラッチパッドにタグを蓄積して、まとめてプロンプトにコピーできます
- A1111拡張モードではtxt2imgのプロンプトを読み出して編集→再送信することができます
- スマートフォンなどモバイル端末でのアクセスに対応（スタンドアロン動作時）。拡張非対応のWEBUI利用時もタブやウインドウを切り替えずにスマホで利用できます。
- お気に入りやピン止めはサーバー側に保存されるため、PC・スマートフォンなど複数端末で共有できます
- LLM 連携可能（任意）: 翻訳csvにない自由入力した日本語をLLMで英訳してタグ検索できます。また日本語で書いたプロンプトを英単語タグに変換できます（Ollama / LM Studio 等のローカル LLM が必要）
- LLM 連携画面でLLMに直接自由なプロンプトを与えて返答させることができます。また登録済みのスキル（定型プロンプト）を利用できます。
  
## A1111 / reForge 拡張としてインストール（推奨）

**Extensions** タブ → **Install from URL** に次の URL を入力してインストールします。

```
https://github.com/<your-repo>/danbooru_tag_explorer
```

または `extensions/` フォルダに本リポジトリをフォルダごと配置してください。

```
stable-diffusion-webui/
└── extensions/
    └── danbooru_tag_explorer/
```

WebUI を再起動すると **DanbooruTagExplorer** タブが追加されます。

### danbooru.csv の準備

拡張モードでは `danbooru.csv` を次のいずれかの方法で用意してください。

1. **[a1111-sd-webui-tagcomplete](https://github.com/DominikDoom/a1111-sd-webui-tagcomplete) を導入済みの場合**、そのCSVを自動で借用します。追加作業は不要です。
2. **スタンドアロンモードで一度起動する**（後述の `run.bat` / `run.sh`）と `data/danbooru.csv` が自動取得されます。その後 WebUI を再起動してください。
3. **手動配置**: 互換CSVを `data/danbooru.csv` としてコピーしてください。

### タグ・翻訳ファイルのパスを変更する

WebUI の **Settings** → **Danbooru Tag Explorer** セクションで設定できます。

| 項目 | 説明 |
|------|------|
| タグCSVファイルパス | 空欄 = 自動検出。絶対パスまたは拡張フォルダ基準の相対パスで指定 |
| 日本語訳CSVファイルパス | 空欄 = `data/ja.csv` |

添付の日本語訳CSVは最低限の内容となっていますので別途翻訳ファイルの導入をお勧めします。
設定変更後は **DanbooruTagExplorer** タブをリロード（ブラウザの更新ボタン）してください。WebUI の再起動は不要です。

> **キャッシュについて**: 拡張の JS / CSS はブラウザにキャッシュされます。ファイルを更新した後は WebUI を再起動してください。再起動後のブラウザ通常リロードで最新版が読み込まれます。

## スタンドアロンで使う（お試し用 / ComfyUI 等のWEBUI利用時）

A1111 以外の環境や動作確認には、スタンドアロンサーバーとして起動できます。Send To / Read From などの A1111 連携機能を除き、タグ探索・LLM 連携などは同様に使用できます。また、同一 LAN 内のスマートフォンやタブレットからもアクセスできるため、PC で画像生成しながら別端末でタグを検索するといった使い方も可能です。

### 必要なもの

- Python 3.9 以上
- **uv**（推奨）または pip で `flask` をインストール済みの環境

uv を使うと依存関係を自動管理します。未導入の場合:

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

### 起動

**Windows:**
```bat
run.bat
```

**macOS / Linux:**
```bash
chmod +x run.sh
./run.sh
```

起動後、ブラウザが自動で開きます。初回起動時に `danbooru.csv` を自動取得します。
同一 LAN の別端末からは、起動時に表示されるローカル IP アドレスでアクセスできます。

## LLM 連携（任意）

ローカル LLM サーバー（Ollama、LM Studio 等）と連携して、日本語テキストを Danbooru タグに変換できます。LLM が稼働していない環境でも本機能以外は通常どおり動作します。

### 対応バックエンド

| バックエンド | デフォルトポート |
|---|---|
| Ollama | 11434 |
| LM Studio | 1234 |
| text-generation-webui | 5000 |
| KoboldCpp | 5001 |
| llama.cpp server | 8080 |
| カスタム | 任意 |

gemma4 E4B 等の 4B クラスモデルを想定しています。VRAM 使用量が画像生成と競合する場合はモデルサイズを調整してください。
(後述のdanbooru スキル利用時はfunction calling 対応モデルが必要です)

### 設定方法

1. ヘッダー右の **⚙ 設定** ボタンをクリック
2. **LLM設定** セクションでプリセットを選択（接続先・ポートが自動補完されます）
3. **🔄** ボタンでモデル一覧を取得し、使用するモデルを選択
4. **保存**

LLM サーバーがモデルをロード済みの場合は起動時に自動検出されるため、設定なしでも利用できます。

### 使い方

**LLM 連携タブ（スクラッチパッド内）:**
日本語で説明文を入力して **→ 変換** をクリックすると Danbooru タグが生成されます。

**スキルモード（`/スキル名` プレフィックス）:**
テキスト入力の先頭に `/` を入力するとスキル候補がドロップダウン表示されます。Tab / Enter で選択するとスキル定義テキストが展開されます。`[temp:N]` をテキスト内に記述すると temperature を上書き指定できます。

| スキルID | 概要 |
|---|---|
| `tag-classify` | タグを意味ごとに分類してコードブロックで出力 |
| `motif` | イラストシチュエーションとタグを生成 |
| `fashion` | 夏向けファッションの SD プロンプトを複数パターン生成 |
| `danbooru` | danbooru.csv を検索しタグを選択（function calling 対応モデルが必要） |
| `history` | 過去のスクラッチパッド内容を元に候補を提案 |

**日本語検索の自動翻訳:**
日本語で検索して結果がゼロ件の場合、LLM が自動的に英単語に変換して再検索します。または検索ボックス右の **🤖** ボタンで手動発火も可能です。翻訳後はクエリのバリアントがチップとして表示され、クリックで切り替えられます。

## ファイル構成

```
danbooru_tag_explorer/
├── index.html          # アプリ本体 (HTML)
├── app.js              # アプリ本体 (JavaScript)
├── dte_app.css         # スタイルシート
├── server.py           # Flask サーバー (静的配信 + REST API)
├── run.bat             # Windows 用起動スクリプト
├── run.sh              # macOS / Linux 用起動スクリプト
└── data/
    ├── tag_tree.json       # カテゴリツリーデータ（同梱）
    ├── danbooru.csv        # タグメタデータ（初回起動時に自動取得）
    ├── ja.csv              # 日本語翻訳データ
    └── settings.json       # お気に入り・ピン止め・LLM設定（自動生成）
```

`danbooru.csv` / `ja.csv` は互換データと差し替え可能です。日本語でのタグ検索性を向上させたい場合は次のデータの導入を推奨します。

- [CIVITAI: tagcomplete用辞書&日本語翻訳辞書 / asugonomi](https://civitai.com/models/2018479/danbooru-tag-complete-csv-tagcompleteand?modelVersionId=2284461)

## データの永続化

**サーバー側に保存（同一サーバーにアクセスする端末間で共有）:**
お気に入りタグ、ピン止めカテゴリ、LLM設定

**ブラウザに保存（端末ごとに独立）:**
AI候補数設定、検索履歴、カテゴリ閲覧履歴、スクラッチパッド

## 同梱データについて

`data/tag_tree.json` は Danbooru Wiki のタググループページから生成したカテゴリツリーデータです。タグ名・Wiki ページ URL・カテゴリ階層を含みます。画像・投稿データは含みません。機械的な生成物であり不適当なカテゴリ分けを含む場合があります。

主な参照元:
- Danbooru: https://danbooru.donmai.us/
- tagcomplete 用 CSV: https://github.com/DominikDoom/a1111-sd-webui-tagcomplete
- タグツリー seed: https://github.com/KohakuBlueleaf/danbooru-tag-tree

## 更新履歴

[CHANGELOG.md](CHANGELOG.md) を参照してください。

## 開発について
本プロジェクトには各種生成AIによる成果物が含まれています。

## License
Code in this repository is licensed under MIT.

Generated tag tree data is derived from public Danbooru wiki/tag metadata and the historical seed structure from KohakuBlueleaf/danbooru-tag-tree. No ownership of Danbooru-originated metadata is claimed. Please follow Danbooru's terms and the upstream sources' terms when using the generated data.