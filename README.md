# Danbooru Tag Explorer

Danbooru のタグをカテゴリツリーから探すためのローカルビューアです。

- カテゴリツリーでタグを階層的に探索
- 各タグのdanbooru wikiプレビュー表示とリンク機能
- タグ名・日本語名での全文インクリメンタル検索
- 複数タグのand検索
- お気に入り・ピン止め（複数端末で共有可）
- 検索・カテゴリ・スクラッチパッドの履歴（ブラウザごとに保持）
- スクラッチパッドへのタグ蓄積とコピー
- モバイル・スマートフォン対応

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

## ファイル構成

```
danbooru_tag_explorer/
├── index.html          # アプリ本体 (HTML)
├── app.js              # アプリ本体 (JavaScript)
├── style.css           # スタイルシート
├── server.py           # Flask サーバー (静的配信 + API)
├── run.bat             # Windows 用起動スクリプト
├── run.sh              # macOS / Linux 用起動スクリプト（未検証）
├── generate_ja.py      # data/ja.csv サンプル生成スクリプト
├── tools/
│   └── build_tag_tree.py   # tag_tree.json 再生成スクリプト(生成物は同梱済み。通常は実行不要です)
└── data/
    ├── tag_tree.json       # カテゴリツリーデータ (同梱)
    ├── danbooru.csv        # タグメタデータ (初回起動時にa1111-sd-webui-tagcompleteのリポジトリより自動取得)
    ├── ja.csv              # 日本語翻訳データ (generate_ja.py で生成)
    └── settings.json       # お気に入り・ピン止め (サーバー側保存、自動生成)
```

## データの永続化

| データ             | 保存先                   | 端末間共有 |
|--------------------|--------------------------|-----------|
| お気に入りタグ     | `data/settings.json`     | 共有される |
| ピン止めカテゴリ   | `data/settings.json`     | 共有される |
| 検索履歴           | ブラウザの localStorage  | 端末ごと  |
| カテゴリ閲覧履歴   | ブラウザの localStorage  | 端末ごと  |
| スクラッチパッド   | ブラウザの localStorage  | 端末ごと  |

お気に入りとピン止めはサーバー側の `data/settings.json` に保存されるため、
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

生成スクリプトは Danbooru Wiki / API にアクセスします。
サーバー負荷を避けるため、繰り返し実行や定期実行はしないでください。
リクエスト間には既定で 1 秒の待機が入っています。

## 開発について

本プロジェクトには各種生成AIによる成果物が含まれています。

## License

Code in this repository is licensed under MIT.

Generated tag tree data is derived from public Danbooru wiki/tag metadata and the
historical seed structure from KohakuBlueleaf/danbooru-tag-tree.
No ownership of Danbooru-originated metadata is claimed.
Please follow Danbooru's terms and the upstream sources' terms when using the generated data.
