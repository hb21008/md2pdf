# md2pdf

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Markdown → HTML → PDF 変換ツール

## 背景と目的

研究進捗やゼミ資料をMarkdownで書きたい。

Markdownは数式・コード・箇条書きなどを簡潔に表現できるし、VSCodeなどのエディタで編集が容易。

しかし指導教員に見せる際は「紙 or PDF」である必要がある。

現状はVSCodeで作成 → Typoraで開いて印刷 → PDF化しており、Typoraを開くのが面倒。

そこで、Markdownファイルを引数に渡すだけでGitHubのCSSが効いたPDFを出力するCLIツールを作成したい。

## 特徴

- **GitHub風のスタイリング**: GitHub Markdown CSS を使用した美しいレイアウト
- **数式対応**: MathJax による LaTeX 数式レンダリング
- **コードハイライト**: highlight.js によるシンタックスハイライト
- **図表対応**: Mermaid によるダイアグラム生成
- **画像処理**: 画像はBase64としてHTMLへ埋め込み。単一HTMLで自己完結。
- **見出しナンバリング**: CSS カウンタによる自動番号付け
- **YAMLフロントマター**: 文書メタ情報の管理
- **詳細ログ**: 処理状況の可視化

## 依存関係

### 必要なライブラリ

```bash
npm install markdown-it markdown-it-anchor markdown-it-github-alerts highlight.js markdown-it-mathjax3 puppeteer js-yaml
```

### パッケージ一覧

- `markdown-it`: Markdown パーサー
- `markdown-it-anchor`: 見出しアンカー生成
- `markdown-it-github-alerts`: GitHubのアラート対応
- `highlight.js`: コードハイライト
- `markdown-it-mathjax3`: MathJax 数式対応
- `puppeteer`: PDF 生成
- `js-yaml`: YAML フロントマター解析

## インストール

```sh
# リポジトリをクローン
git clone <repository-url>
cd md2pdf

# 依存関係をインストール
npm install

# 実行権限を付与
chmod +x md2pdf.mjs
```

## 使用方法

### 基本的な使い方

```sh
# 基本的な変換
./md2pdf.mjs input.md

# 出力ファイル名を指定
./md2pdf.mjs input.md output.pdf

# HTMLも保存する
./md2pdf.mjs input.md --save-html

# 詳細ログを表示
./md2pdf.mjs input.md --verbose

# 複数オプションの組み合わせ
./md2pdf.mjs input.md output.pdf --save-html --verbose
```

### エイリアス設定

`.zshrc` に以下を追加：

```sh
alias md2pdf="node $HOME/<your-tools-dir>/md2pdf/md2pdf.mjs"
```

## YAMLフロントマター

Markdown ファイルの先頭に YAML フロントマターを記述できます：

```yaml
---
date: 2025-10-11
author: <Your Name>
affiliation: <Your Affiliation>
---

# 研究タイトル

本文...
```

### 対応フィールド

- `date`: PDF ヘッダーに表示される日付
- `author`: 著者名（H1直下に表示）
- `affiliation`: 所属（H1直下に表示）

## 環境変数

以下の環境変数で動作をカスタマイズできます：

### HTML スタイル設定

```sh
export MD2HTML_FONT_SIZE="14px"           # フォントサイズ
export MD2HTML_LINE_HEIGHT="1.6"          # 行間
export MD2HTML_PADDING_X="32px"           # 左右パディング
export MD2HTML_PADDING_Y="24px"           # 上下パディング
export MD2HTML_CODE_FONT_SCALE="1em"      # コードフォントサイズ
export MD2HTML_PAGE_BG="#fff"             # ページ背景色
export MD2HTML_CODE_BG="#f6f8fa"          # コード背景色
export MD2HTML_MAX_WIDTH="auto"           # 最大幅
export MD2HTML_AUTO_NUMBER="1"            # 見出しナンバリング（0=無効）
```

### PDF 設定

```sh
export MD2PDF_FORMAT="A4"                 # 用紙サイズ
export MD2PDF_SCALE="1"                   # スケール
export MD2PDF_MARGIN_TOP="20mm"           # 上余白
export MD2PDF_MARGIN_RIGHT="12mm"         # 右余白
export MD2PDF_MARGIN_BOTTOM="16mm"        # 下余白
export MD2PDF_MARGIN_LEFT="12mm"          # 左余白
export MD2PDF_PRINT_BG="1"                # 背景印刷（0=無効）
export MD2PDF_SAVE_HTML="0"               # HTML保存（1=有効）
export MD2PDF_VERBOSE="0"                 # 詳細ログ（1=有効）
```

## 印刷

```sh
lp your-file.pdf
```

> [!NOTE]
> **macOSでCanon MF741C/743Cを片面印刷にする方法**
>
> - 最初に `lp -o sides=one-sided` を試すが、**両面印刷のまま**になる。
> → macOSのCUPSではプリンタドライバ側の設定が優先される。
> - `lpoptions` で確認したところ、ドライバは **Canon MF741C/743C CARPS2**。
> → このドライバは標準オプション `sides=` を無視する。
> - 一般的な `-o Duplex=None` も無効。Canon独自オプションを探す必要がある。
> - `lpoptions -l` で詳細一覧を出すと、
>   **`CNDuplex/Print Style: None *DuplexFront`** という項目を発見。
>   → これが片面／両面の切り替えキー。
> - 片面印刷する場合のコマンド：
>
>   ```bash
>   lp -d Canon_MF741C_743C__... -o CNDuplex=None your-file.pdf
>   ```
>
>   これで**片面印刷成功**。
> - 恒久設定も可能：
>
>   ```bash
>   lpoptions -p Canon_MF741C_743C__... -o CNDuplex=None
>   ```
>
>   以後は `lp <file>` だけで片面になる。
>
> **まとめ：**
> CanonのCARPS2ドライバでは `sides=` や `Duplex=` は無効。
> 片面印刷したい場合は **`-o CNDuplex=None`** が唯一正しく動作する。

## LICENSE

The MIT License

Copyright (c) 2025 ppr

本ソフトウェアおよび関連する文書のファイル（以下「ソフトウェア」）の複製を取得した全ての人物に対し、以下の条件に従うことを前提に、ソフトウェアを無制限に扱うことを無償で許可します。これには、ソフトウェアの複製を使用、複製、改変、結合、公開、頒布、再許諾、および/または販売する権利、およびソフトウェアを提供する人物に同様の行為を許可する権利が含まれますが、これらに限定されません。

上記の著作権表示および本許諾表示を、ソフトウェアの全ての複製または実質的な部分に記載するものとします。

ソフトウェアは「現状有姿」で提供され、商品性、特定目的への適合性、および権利の非侵害性に関する保証を含むがこれらに限定されず、明示的であるか黙示的であるかを問わず、いかなる種類の保証も行われません。著作者または著作権者は、契約、不法行為、またはその他の行為であるかを問わず、ソフトウェアまたはソフトウェアの使用もしくはその他に取り扱いに起因または関連して生じるいかなる請求、損害賠償、その他の責任について、一切の責任を負いません。
