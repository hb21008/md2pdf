#!/usr/bin/env node
/**
 * Markdown → HTML → PDF 変換ツール（統合版）
 * - MathJax (SVG) / Mermaid / hljs / GitHub Markdown CSS 対応
 * - 見出しの自動ナンバリング（CSSカウンタ）
 * - Puppeteer により PDF も生成
 *
 * 依存:
 *   npm i markdown-it markdown-it-anchor highlight.js markdown-it-mathjax3 puppeteer
 *
 * 使い方:
 *   ./md2pdf.mjs input.md
 *   ./md2pdf.mjs input.md output.pdf
 *   ./md2pdf.mjs input.md output.pdf --save-html
 *   ./md2pdf.mjs input.md output.pdf --verbose
 *   ./md2pdf.mjs input.md output.pdf --save-html --verbose
 *   ./md2pdf.mjs input.md output.pdf --save-html --verbose
 */

import fs from "fs";
import path from "path";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import hljs from "highlight.js";
import mathjax3 from "markdown-it-mathjax3";
import puppeteer from "puppeteer";
import yaml from "js-yaml";

// ===== CLI args =====
if (process.argv.length < 3) {
  console.error("Usage: md2pdf.mjs input.md [output.pdf] [--save-html] [--verbose|-v]");
  process.exit(2);
}

// フラグを除外した引数リストを作成
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--') && arg !== '-v');
if (args.length === 0) {
  console.error("Usage: md2pdf.mjs input.md [output.pdf] [--save-html] [--verbose|-v]");
  process.exit(2);
}

const inPath = args[0];
const baseName = path.basename(inPath, ".md");
const htmlOut = path.join("out-html", `${baseName}.html`);
const saveHtmlFlag = process.argv.includes('--save-html');
const verboseFlag = process.argv.includes('--verbose') || process.argv.includes('-v');
const pdfOut = args[1] || path.join("out-pdf", `${baseName}.pdf`);
fs.mkdirSync("out-pdf", { recursive: true });

// ===== Config =====
const CFG = {
  FONT_SIZE: process.env.MD2HTML_FONT_SIZE || "14px",
  LINE_HEIGHT: process.env.MD2HTML_LINE_HEIGHT || "1.6",
  PADDING_X: process.env.MD2HTML_PADDING_X || "32px",
  PADDING_Y: process.env.MD2HTML_PADDING_Y || "24px",
  CODE_FONT_SCALE: process.env.MD2HTML_CODE_FONT_SCALE || "1em",
  PAGE_BG: process.env.MD2HTML_PAGE_BG || "#fff",
  CODE_BG: process.env.MD2HTML_CODE_BG || "#f6f8fa",
  MAX_WIDTH: process.env.MD2HTML_MAX_WIDTH || "auto",
  AUTO_NUMBER: (process.env.MD2HTML_AUTO_NUMBER ?? "1") !== "0",
  SAVE_HTML: saveHtmlFlag || (process.env.MD2PDF_SAVE_HTML ?? "0") !== "0",
  VERBOSE: verboseFlag || (process.env.MD2PDF_VERBOSE ?? "0") !== "0",

  // PDF用
  PDF_FORMAT: process.env.MD2PDF_FORMAT || "A4",
  PDF_SCALE: Number(process.env.MD2PDF_SCALE || "1"),
  PDF_MARGIN_TOP: process.env.MD2PDF_MARGIN_TOP || "20mm",
  PDF_MARGIN_RIGHT: process.env.MD2PDF_MARGIN_RIGHT || "12mm",
  PDF_MARGIN_BOTTOM: process.env.MD2PDF_MARGIN_BOTTOM || "16mm",
  PDF_MARGIN_LEFT: process.env.MD2PDF_MARGIN_LEFT || "12mm",
  PDF_PRINT_BG: (process.env.MD2PDF_PRINT_BG ?? "1") !== "0",
};

// ===== Read Markdown =====
log(`🚀 変換開始: ${baseName}.md`, 'always');
const src = fs.readFileSync(inPath, "utf8");
const { frontMatter, content: markdownContent } = parseYamlFrontMatter(src);

// ===== Markdown-it 設定 =====
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return `<pre><code class="hljs language-${lang}">` + hljs.highlight(code, { language: lang }).value + `</code></pre>`;
    }
    const r = hljs.highlightAuto(code);
    return `<pre><code class="hljs ${r.language ? "language-" + r.language : ""}">` + r.value + `</code></pre>`;
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
  });

// Mermaid対応
const origFence = md.renderer.rules.fence || ((tokens, idx, options, env, slf) => slf.renderToken(tokens, idx, options, env, slf));
md.renderer.rules.fence = function (tokens, idx, options, env, slf) {
  const t = tokens[idx];
  const info = (t.info || "").trim().toLowerCase();
  if (info === "mermaid") {
    return `<div class="mermaid">\n${t.content}\n</div>\n`;
  }
  return origFence(tokens, idx, options, env, slf);
};

// ===== YAMLフロントマター解析関数 =====
function parseYamlFrontMatter(content) {
  const yamlRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(yamlRegex);
  
  if (!match) {
    return { frontMatter: {}, content: content };
  }
  
  try {
    const frontMatter = yaml.load(match[1]) || {};
    return { frontMatter, content: match[2] };
  } catch (error) {
    console.warn(`⚠️ YAMLフロントマターの解析に失敗: ${error.message}`);
    return { frontMatter: {}, content: content };
  }
}

// ===== メタ情報生成関数 =====
function generateMetaInfo(frontMatter) {
  const { author, affiliation } = frontMatter;
  
  if (!author && !affiliation) {
    return '';
  }
  
  let metaHtml = '<div class="document-meta">';
  
  if (author) {
    metaHtml += `<div class="meta-author">${author}</div>`;
  }
  
  if (affiliation) {
    metaHtml += `<div class="meta-affiliation">${affiliation}</div>`;
  }
  
  metaHtml += '</div>';
  return metaHtml;
}

// ===== ログ出力関数 =====
function log(message, level = 'info') {
  if (level === 'always' || CFG.VERBOSE) {
    console.log(message);
  }
}

// ===== 画像パス処理関数 =====
function convertImagePaths(html, basePath, embedBase64) {
  const supportedExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
  let imageCount = 0;
  let convertedCount = 0;
  
  const result = html.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g, (match, imgPath) => {
    imageCount++;
    // URL（http/https）の場合はそのまま
    if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) {
      return match;
    }
    
    let resolvedPath;
    if (path.isAbsolute(imgPath)) {
      resolvedPath = imgPath;
    } else {
      resolvedPath = path.resolve(basePath, imgPath);
    }
    
    // ファイルが存在しない場合はそのまま
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`⚠️ 画像ファイルが見つかりません: ${resolvedPath}`);
      return match;
    }
    
    // 拡張子をチェック
    const ext = path.extname(resolvedPath).slice(1).toLowerCase();
    if (!supportedExts.includes(ext)) {
      console.warn(`⚠️ サポートされていない画像形式: ${ext}`);
      return match;
    }
    
    if (embedBase64) {
      // Base64エンコード
      try {
        const imgBuffer = fs.readFileSync(resolvedPath);
        const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
        const base64 = imgBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64}`;
        convertedCount++;
        return match.replace(imgPath, dataUri);
      } catch (error) {
        console.warn(`⚠️ 画像の読み込みに失敗: ${resolvedPath}`, error.message);
        return match;
      }
    } else {
      // 絶対パス（file:// プロトコル付き）
      const fileUri = `file://${resolvedPath}`;
      return match.replace(imgPath, fileUri);
    }
  });
  
  if (imageCount > 0) {
    log(`🖼️  画像処理: ${imageCount}個の画像を検出${embedBase64 ? `、Base64変換: ${convertedCount}個` : ''}`);
  }
  
  return result;
}

// ===== HTML生成 =====
log(`📋 モード: ${CFG.SAVE_HTML ? 'HTML保存あり（絶対パス）' : 'HTML保存なし（Base64埋め込み）'}`);
log('📝 Markdown → HTML 変換中...');
const bodyHtml = md.render(markdownContent);
const processedBodyHtml = convertImagePaths(bodyHtml, path.dirname(path.resolve(inPath)), !CFG.SAVE_HTML);

// YAMLフロントマターからメタ情報を生成
const metaInfo = generateMetaInfo(frontMatter);

// H1の直後にメタ情報を挿入
const h1Regex = /(<h1[^>]*>.*?<\/h1>)/;
const finalBodyHtml = processedBodyHtml.replace(h1Regex, `$1${metaInfo}`);

log('✅ HTML生成完了');

const headingNumberCSS = CFG.AUTO_NUMBER ? `
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
.markdown-body h6::before { content: counter(h2counter) "." counter(h3counter) "." counter(h4counter) "." counter(h5counter) "." counter(h6counter) ". "; }
` : "";

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${baseName}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
<style>
  :root {
    --font-size: ${CFG.FONT_SIZE};
    --line-height: ${CFG.LINE_HEIGHT};
    --pad-x: ${CFG.PADDING_X};
    --pad-y: ${CFG.PADDING_Y};
    --code-font-scale: ${CFG.CODE_FONT_SCALE};
    --page-bg: ${CFG.PAGE_BG};
    --code-bg: ${CFG.CODE_BG};
    --max-width: ${CFG.MAX_WIDTH};
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
${finalBodyHtml}
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

if (CFG.SAVE_HTML) {
  fs.mkdirSync("out-html", { recursive: true });
  fs.writeFileSync(htmlOut, html);
  console.log(`✔ HTML generated: ${htmlOut}`);
}

// ===== PDF生成 =====
(async () => {
  try {
    log('🌐 Puppeteer起動中...');
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    
    if (CFG.SAVE_HTML) {
      log(`📄 HTMLファイルから読み込み中: ${htmlOut}`);
      await page.goto(`file://${path.resolve(htmlOut)}`, { waitUntil: "networkidle0" });
    } else {
      log('📄 HTMLをメモリから読み込み中...');
      await page.setContent(html, { waitUntil: "networkidle0" });
    }

    log('⏳ MathJax/Mermaid レンダリング待機中...');
    await page.waitForFunction(() => document.readyState === "complete");
    await page.evaluate(async () => {
      if (window.mermaid) await mermaid.run({ querySelector: ".mermaid" });
      if (window.MathJax && MathJax.typesetPromise) await MathJax.typesetPromise();
    });

    log('📄 PDF生成中...');
    await page.pdf({
      path: pdfOut,
      format: CFG.PDF_FORMAT,
      scale: CFG.PDF_SCALE,
      printBackground: CFG.PDF_PRINT_BG,
      margin: {
        top: CFG.PDF_MARGIN_TOP,
        right: CFG.PDF_MARGIN_RIGHT,
        bottom: CFG.PDF_MARGIN_BOTTOM,
        left: CFG.PDF_MARGIN_LEFT,
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
          ${frontMatter.date ? new Date(frontMatter.date).toLocaleDateString('ja-JP') : new Date().toLocaleDateString('ja-JP')}
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

    await browser.close();
    console.log(`✔ PDF generated: ${pdfOut}`);
  } catch (error) {
    console.error(`❌ エラー: ${error.message}`);
    process.exit(1);
  }
})();
