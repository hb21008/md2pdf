#!/usr/bin/env node
/**
 * Markdown → HTML → PDF 変換ツール（統合版）
 * - MathJax (SVG) / Mermaid / hljs / GitHub Markdown CSS 対応
 * - 見出しの自動ナンバリング（CSSカウンタ）
 * - Puppeteer により PDF も生成
 *
 * 依存:
 *   npm i markdown-it markdown-it-anchor highlight.js markdown-it-mathjax3 markdown-it-github-alerts puppeteer js-yaml
 *
 * 使い方:
 *   ./md2pdf.mjs input.md
 *   ./md2pdf.mjs input.md output.pdf
 *   ./md2pdf.mjs input.md output.pdf --save-html
 *   ./md2pdf.mjs input.md output.pdf --verbose
 *   ./md2pdf.mjs input.md output.pdf --save-html --verbose
 */

import fs from "fs";
import path from "path";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import hljs from "highlight.js";
import mathjax3 from "markdown-it-mathjax3";
import githubAlerts from "markdown-it-github-alerts";
import puppeteer from "puppeteer";
import yaml from "js-yaml";

// ========================================
// ユーティリティ関数群
// ========================================

const fsp = fs.promises;

/**
 * コマンドライン引数を解析
 * @param {string[]} argv - process.argv
 * @returns {{input: string, output: string|null, verbose: boolean, saveHtml: boolean}}
 */
function parseArgs(argv) {
  const flags = new Set();
  const pos = [];
  
  for (const arg of argv.slice(2)) {
    if (arg === "-v" || arg === "--verbose") {
      flags.add("verbose");
    } else if (arg === "--save-html") {
      flags.add("saveHtml");
    } else if (arg.startsWith("--")) {
      throw new Error(`未知のフラグ: ${arg}`);
    } else {
      pos.push(arg);
    }
  }
  
  if (pos.length < 1 || pos.length > 2) {
    throw new Error("Usage: md2pdf.mjs input.md [output.pdf] [--save-html] [--verbose|-v]");
  }
  
  return {
    input: pos[0],
    output: pos[1] || null,
    verbose: flags.has("verbose"),
    saveHtml: flags.has("saveHtml"),
  };
}

/**
 * 設定オブジェクトを構築
 * @param {{verbose: boolean, saveHtml: boolean}} cli - CLI引数
 * @returns {Object} 設定オブジェクト
 */
function buildConfig(cli) {
  const env = (key, defaultValue) => process.env[key] ?? defaultValue;
  
  return {
    FONT_SIZE: env("MD2HTML_FONT_SIZE", "14px"),
    LINE_HEIGHT: env("MD2HTML_LINE_HEIGHT", "1.6"),
    PADDING_X: env("MD2HTML_PADDING_X", "32px"),
    PADDING_Y: env("MD2HTML_PADDING_Y", "24px"),
    CODE_FONT_SCALE: env("MD2HTML_CODE_FONT_SCALE", "1em"),
    PAGE_BG: env("MD2HTML_PAGE_BG", "#fff"),
    CODE_BG: env("MD2HTML_CODE_BG", "#f6f8fa"),
    MAX_WIDTH: env("MD2HTML_MAX_WIDTH", "auto"),
    AUTO_NUMBER: env("MD2HTML_AUTO_NUMBER", "1") !== "0",
    SAVE_HTML: cli.saveHtml || env("MD2PDF_SAVE_HTML", "0") !== "0",
    VERBOSE: cli.verbose || env("MD2PDF_VERBOSE", "0") !== "0",
    PDF_FORMAT: env("MD2PDF_FORMAT", "A4"),
    PDF_SCALE: Number(env("MD2PDF_SCALE", "1")),
    PDF_MARGIN_TOP: env("MD2PDF_MARGIN_TOP", "20mm"),
    PDF_MARGIN_RIGHT: env("MD2PDF_MARGIN_RIGHT", "12mm"),
    PDF_MARGIN_BOTTOM: env("MD2PDF_MARGIN_BOTTOM", "16mm"),
    PDF_MARGIN_LEFT: env("MD2PDF_MARGIN_LEFT", "12mm"),
    PDF_PRINT_BG: env("MD2PDF_PRINT_BG", "1") !== "0",
  };
}

/**
 * ロガーオブジェクトを生成
 * @param {boolean} enabled - verbose モード
 * @returns {{info: Function, always: Function, warn: Function, error: Function}}
 */
function makeLogger(enabled) {
  return {
    info: (...args) => enabled && console.log(...args),
    always: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

// ========================================
// Markdown処理関数群
// ========================================

/**
 * YAMLフロントマターを解析
 * @param {string} content - Markdownコンテンツ
 * @returns {{frontMatter: Object, body: string}}
 */
function parseYamlFrontMatter(content) {
  const yamlRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(yamlRegex);
  
  if (!match) {
    return { frontMatter: {}, body: content };
  }
  
  try {
    const frontMatter = yaml.load(match[1]) || {};
    return { frontMatter, body: match[2] };
  } catch (error) {
    console.warn(`⚠️ YAMLフロントマターの解析に失敗: ${error.message}`);
    return { frontMatter: {}, body: content };
  }
}

/**
 * Markdown-itインスタンスを構築
 * @returns {MarkdownIt} 設定済みのMarkdown-itインスタンス
 */
function buildMarkdownIt() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        return `<pre><code class="hljs language-${lang}">` + 
               hljs.highlight(code, { language: lang }).value + 
               `</code></pre>`;
      }
      const result = hljs.highlightAuto(code);
      return `<pre><code class="hljs ${result.language ? "language-" + result.language : ""}">` + 
             result.value + 
             `</code></pre>`;
    },
  })
    .use(anchor)
    .use(mathjax3, {
      tex: {
        inlineMath: [["$", "$"], ["\\(", "\\)"]],
        displayMath: [["$$", "$$"], ["\\[", "\\]"]],
        packages: { "[+]": ["ams"] },
      },
      loader: { load: ["[tex]/ams"] },
    })
    .use(githubAlerts);

  // Mermaid対応
  const baseFence = md.renderer.rules.fence || 
    ((tokens, idx, options, env, slf) => slf.renderToken(tokens, idx, options, env, slf));
  
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().toLowerCase();
    if (info === "mermaid") {
      return `<div class="mermaid">\n${token.content}\n</div>\n`;
    }
    return baseFence(tokens, idx, options, env, slf);
  };
  
  return md;
}

/**
 * メタ情報HTMLを生成
 * @param {Object} frontMatter - フロントマター
 * @returns {string} メタ情報HTML
 */
function generateMetaInfo(frontMatter) {
  const { author, affiliation } = frontMatter || {};
  
  if (!author && !affiliation) {
    return "";
  }
  
  return `
  <div class="document-meta">
    ${author ? `<div class="meta-author">${author}</div>` : ""}
    ${affiliation ? `<div class="meta-affiliation">${affiliation}</div>` : ""}
  </div>`;
}

/**
 * H1直後にメタ情報を挿入
 * @param {string} html - HTMLコンテンツ
 * @param {string} metaHtml - メタ情報HTML
 * @returns {string} 変換後のHTML
 */
function insertAfterFirstH1(html, metaHtml) {
  if (!metaHtml) {
    return html;
  }
  const h1Regex = /(<h1[^>]*>.*?<\/h1>)/s;
  return html.replace(h1Regex, `$1${metaHtml}`);
}

// ========================================
// 画像処理関数
// ========================================

/**
 * 画像パスを処理（Base64埋め込みまたはfile://変換）
 * @param {string} html - HTMLコンテンツ
 * @param {string} baseDir - ベースディレクトリ
 * @param {boolean} embedBase64 - Base64埋め込みフラグ
 * @param {Object} log - ロガー
 * @returns {Promise<string>} 処理後のHTML
 */
async function processImages(html, baseDir, embedBase64, log) {
  const supportedExts = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
  const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
  const imageMap = new Map();
  
  // 画像パスを収集
  html.replace(imgRegex, (_match, src) => {
    imageMap.set(src, null);
    return _match;
  });
  
  const tasks = [];
  
  for (const src of imageMap.keys()) {
    // URL（http/https）はスキップ
    if (/^https?:\/\//i.test(src)) {
      continue;
    }
    
    const absPath = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
    
    try {
      const stat = await fsp.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        log.warn(`⚠️ 画像ファイルが見つかりません: ${absPath}`);
        continue;
      }
      
      const ext = path.extname(absPath).slice(1).toLowerCase();
      if (!supportedExts.has(ext)) {
        log.warn(`⚠️ サポートされていない画像形式: ${ext}`);
        continue;
      }
      
      if (embedBase64) {
        // Base64エンコード（並行処理）
        tasks.push(
          fsp.readFile(absPath).then((buffer) => {
            const mimeType = ext === "svg" ? "image/svg+xml" : `image/${ext}`;
            const base64 = buffer.toString("base64");
            imageMap.set(src, `data:${mimeType};base64,${base64}`);
          })
        );
      } else {
        // file:// プロトコル付き絶対パス
        const fileUrl = new URL(`file://${absPath}`);
        imageMap.set(src, fileUrl.href);
      }
    } catch (error) {
      log.warn(`⚠️ 画像処理失敗: ${absPath} (${error.message})`);
    }
  }
  
  // すべての画像処理を並行実行
  await Promise.all(tasks);
  
  // 画像パスを置換
  const result = html.replace(imgRegex, (match, src) => {
    const newSrc = imageMap.get(src);
    return newSrc ? match.replace(src, newSrc) : match;
  });
  
  const processedCount = Array.from(imageMap.values()).filter(v => v !== null).length;
  if (imageMap.size > 0) {
    log.info(`🖼️  画像処理: ${imageMap.size}個の画像を検出${embedBase64 ? `、Base64変換: ${processedCount}個` : ''}`);
  }
  
  return result;
}

// ========================================
// HTML生成関数群
// ========================================

/**
 * 見出しナンバリングCSSを生成
 * @param {boolean} enabled - 自動ナンバリング有効フラグ
 * @returns {string} CSS文字列
 */
function buildHeadingNumberCSS(enabled) {
  if (!enabled) {
    return "";
  }
  
  return `
.markdown-body { counter-reset: h2counter; }
.markdown-body h2 { counter-increment: h2counter; counter-reset: h3counter; }
.markdown-body h2::before { content: counter(h2counter) ". "; }
.markdown-body h3 { counter-increment: h3counter; counter-reset: h4counter; }
.markdown-body h3::before { content: counter(h2counter) "." counter(h3counter) ". "; }
.markdown-body h4 { counter-increment: h4counter; counter-reset: h5counter; }
.markdown-body h4::before { content: counter(h2counter) "." counter(h3counter) "." counter(h4counter) ". "; }
.markdown-body h5 { counter-increment: h5counter; counter-reset: h6counter; }
.markdown-body h5::before { content: counter(h2counter) "." counter(h3counter) "." counter(h4counter) "." counter(h5counter) ". "; }
.markdown-body h6 { counter-increment: h6counter; }
.markdown-body h6::before { content: counter(h2counter) "." counter(h3counter) "." counter(h4counter) "." counter(h5counter) "." counter(h6counter) ". "; }`;
}

/**
 * HTML全体を組み立て
 * @param {{title: string, body: string, cfg: Object}} params
 * @returns {string} 完全なHTML
 */
function buildHtml({ title, body, cfg }) {
  const headingNumberCSS = buildHeadingNumberCSS(cfg.AUTO_NUMBER);
  
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
<style>
  :root {
    --font-size: ${cfg.FONT_SIZE};
    --line-height: ${cfg.LINE_HEIGHT};
    --pad-x: ${cfg.PADDING_X};
    --pad-y: ${cfg.PADDING_Y};
    --code-font-scale: ${cfg.CODE_FONT_SCALE};
    --page-bg: ${cfg.PAGE_BG};
    --code-bg: ${cfg.CODE_BG};
    --max-width: ${cfg.MAX_WIDTH};
  }
  body { margin:0; background:var(--page-bg); }
  .markdown-body {
    margin:0 auto;
    padding:var(--pad-y) var(--pad-x);
    font-size:var(--font-size);
    line-height:var(--line-height);
    max-width:var(--max-width);
  }
  pre {
    background: var(--code-bg);
    border-radius:6px;
    padding:12px 16px;
    white-space: pre-wrap;
    overflow-x: visible;              /* 横スクロール禁止 */
  }
  code { font-size: var(--code-font-scale); }
  .markdown-body pre code.hljs {
    white-space: pre-wrap !important;
    word-break: break-word;           /* 長い識別子/URLを折る */
    overflow-wrap: anywhere;          /* どこでも折って良い */
    display: block;                   /* 幅いっぱいにして折返し計算を安定 */
  }
  .markdown-body :not(pre) > code {
    white-space: normal;              /* インラインは通常の改行規則 */
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  .document-meta {
    display: inline-block;    /* 内容に追従 */
    max-width: min(68ch, 100%); /* 可読域の上限確保 */
    margin: 1em 0;
    padding: 0.9em 1em;
    background-color: #f8f9fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font-size: 0.9em;
    line-height: 1.6;
    color: #24292f;
  }
  .meta-author {
    font-weight: 600;
    margin-bottom: 0.25em;
  }
  .meta-affiliation {
    color: #57606a;
    font-size: 0.95em;
  }

  ${headingNumberCSS}
  @media print {
    .page-break { page-break-after: always; }
    .markdown-body pre code.hljs {
      white-space: pre-wrap !important;
      word-break: break-word;
      overflow-wrap: anywhere;
      display: block;
    }
    svg { shape-rendering: geometricPrecision; } /* MathJaxのにじみ軽減 */
  }
</style>
<script>
  window.MathJax = { options: { ignoreHtmlClass: 'mermaid' } };
</script>
<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js"></script>
</head>
<body>
<div class="markdown-body">
${body}
</div>
<script>
document.addEventListener('DOMContentLoaded', async () => {
  try {
    if (window.mermaid) { mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' }); await mermaid.run({ querySelector: '.mermaid' }); }
    if (window.hljs) { document.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el)); }
  } catch(e){ console.error(e); }
});
</script>
</body>
</html>`;
}

// ========================================
// PDF生成関数
// ========================================

/**
 * PuppeteerでPDFを生成
 * @param {{html: string, htmlPath: string|null, pdfPath: string, cfg: Object, dateStr: string}} params
 */
async function renderPDF({ html, htmlPath, pdfPath, cfg, dateStr }) {
  const browser = await puppeteer.launch({ 
    headless: "new", 
    args: ["--no-sandbox"] 
  });
  
  try {
    const page = await browser.newPage();
    
    if (htmlPath) {
      const fileUrl = new URL(`file://${htmlPath}`);
      await page.goto(fileUrl.href, { waitUntil: "networkidle0" });
    } else {
      await page.setContent(html, { waitUntil: "networkidle0" });
    }
    
    await page.waitForFunction(() => document.readyState === "complete");
    await page.evaluate(async () => {
      if (window.mermaid) {
        await mermaid.run({ querySelector: ".mermaid" });
      }
      if (window.MathJax && MathJax.typesetPromise) {
        await MathJax.typesetPromise();
      }
    });
    
    await page.pdf({
      path: pdfPath,
      format: cfg.PDF_FORMAT,
      scale: cfg.PDF_SCALE,
      printBackground: cfg.PDF_PRINT_BG,
      margin: {
        top: cfg.PDF_MARGIN_TOP,
        right: cfg.PDF_MARGIN_RIGHT,
        bottom: cfg.PDF_MARGIN_BOTTOM,
        left: cfg.PDF_MARGIN_LEFT,
      },
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="
          font-size:12px;
          font-family:-apple-system, BlinkMacSystemFont, 'Noto Sans JP', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif;
          text-align:left;
          width:100%;
          margin-left:10mm;
        ">
          ${dateStr}
        </div>`,
      footerTemplate: `
        <div style="
          font-size:12px;
          font-family:-apple-system, BlinkMacSystemFont, 'Noto Sans JP', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif;
          width:100%;
          display:flex;
          justify-content:space-between;
          align-items:center;
          margin:0 10mm;
        ">
          <div>GitHub Markdown CSS / highlight.js / MathJax / Mermaid / Node.js</div>
          <div><span class="pageNumber"></span>/<span class="totalPages"></span></div>
        </div>`,
    });
  } finally {
    await browser.close();
  }
}

// ========================================
// メイン関数
// ========================================

/**
 * メインエントリーポイント
 */
async function main() {
  let exitCode = 0;
  
  try {
    // 引数解析と設定構築
    const cli = parseArgs(process.argv);
    const cfg = buildConfig(cli);
    const log = makeLogger(cfg.VERBOSE);
    
    // パス設定
    const inPath = cli.input;
    const baseName = path.basename(inPath, ".md");
    const pdfOut = cli.output || path.join("out-pdf", `${baseName}.pdf`);
    const htmlOut = path.join("out-html", `${baseName}.html`);
    
    // 出力ディレクトリ作成
    await fsp.mkdir(path.dirname(pdfOut), { recursive: true });
    
    log.always(`🚀 変換開始: ${baseName}.md`);
    log.info(`📋 モード: ${cfg.SAVE_HTML ? 'HTML保存あり（絶対パス）' : 'HTML保存なし（Base64埋め込み）'}`);
    
    // Markdownファイル読み込み
    const src = await fsp.readFile(inPath, "utf8");
    const { frontMatter, body } = parseYamlFrontMatter(src);
    
    // Markdown → HTML変換
    log.info("📝 Markdown → HTML 変換中...");
    const md = buildMarkdownIt();
    const bodyHtml = md.render(body);
    
    // 画像処理
    const processedBodyHtml = await processImages(
      bodyHtml,
      path.dirname(path.resolve(inPath)),
      !cfg.SAVE_HTML,
      log
    );
    
    // メタ情報挿入
    const metaInfo = generateMetaInfo(frontMatter);
    const finalBodyHtml = insertAfterFirstH1(processedBodyHtml, metaInfo);
    
    // HTML全体組み立て
    const html = buildHtml({ title: baseName, body: finalBodyHtml, cfg });
    log.info("✅ HTML生成完了");
    
    // HTML保存（必要に応じて）
    if (cfg.SAVE_HTML) {
      await fsp.mkdir(path.dirname(htmlOut), { recursive: true });
      await fsp.writeFile(htmlOut, html);
      log.always(`✔ HTML generated: ${htmlOut}`);
    }
    
    // PDF生成
    const dateStr = frontMatter.date
      ? new Date(frontMatter.date).toLocaleDateString("ja-JP")
      : new Date().toLocaleDateString("ja-JP");
    
    log.info("🌐 Puppeteer起動中...");
    if (cfg.SAVE_HTML) {
      log.info(`📄 HTMLファイルから読み込み中: ${htmlOut}`);
    } else {
      log.info("📄 HTMLをメモリから読み込み中...");
    }
    log.info("⏳ MathJax/Mermaid レンダリング待機中...");
    log.info("📄 PDF生成中...");
    
    await renderPDF({
      html,
      htmlPath: cfg.SAVE_HTML ? path.resolve(htmlOut) : null,
      pdfPath: pdfOut,
      cfg,
      dateStr,
    });
    
    log.always(`✔ PDF generated: ${pdfOut}`);
    log.always(`💡 To print the file:`);
    log.always(`   lp ${pdfOut}`);
  } catch (error) {
    console.error(`❌ エラー: ${error.message}`);
    exitCode = 1;
  } finally {
    process.exitCode = exitCode;
  }
}

// ========================================
// 実行
// ========================================

main();
