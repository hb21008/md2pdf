#!/usr/bin/env node
/**
 * Markdown → HTML 変換ツール（MathJax SVG / Mermaid / hljs / GitHub CSS）
 * - Mermaid 内の数式処理は無視して衝突回避（MathJax options.ignoreHtmlClass = 'mermaid'）
 * - 見出しの自動ナンバリング（CSSカウンタ、可読なCSS）
 * 依存: npm i markdown-it markdown-it-anchor highlight.js markdown-it-mathjax3
 */

import fs from "fs";
import path from "path";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import hljs from "highlight.js";
import mathjax3 from "markdown-it-mathjax3";

// ===== CLI args =====
if (process.argv.length < 3) {
  console.error("Usage: md2html.mjs input.md [output.html]");
  process.exit(2);
}
const inPath = process.argv[2];
const outPath = process.argv[3] || path.join(process.cwd(), "out-html", `${path.basename(inPath, ".md")}.html`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ===== Config (環境変数で上書き可) =====
const CFG = {
  FONT_SIZE: process.env.MD2HTML_FONT_SIZE || "14px",
  LINE_HEIGHT: process.env.MD2HTML_LINE_HEIGHT || "1.6",
  PADDING_X: process.env.MD2HTML_PADDING_X || "32px",
  PADDING_Y: process.env.MD2HTML_PADDING_Y || "24px",
  CODE_FONT_SCALE: process.env.MD2HTML_CODE_FONT_SCALE || "1em",
  PAGE_BG: process.env.MD2HTML_PAGE_BG || "#fff",
  CODE_BG: process.env.MD2HTML_CODE_BG || "#f6f8fa",
  MAX_WIDTH: process.env.MD2HTML_MAX_WIDTH || "auto",
  AUTO_NUMBER: (process.env.MD2HTML_AUTO_NUMBER ?? "1") !== "0", // 1=ON, 0=OFF
};

// ===== Read source =====
const src = fs.readFileSync(inPath, "utf8");

// ===== Markdown-it (GFM風 + hljs) =====
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
      inlineMath: [["$", "$"] , ["\\(", "\\)"]],
      displayMath: [["$$","$$"], ["\\[", "\\]"]],
      packages: { "[+]": ["ams"] },
    },
    loader: { load: ["[tex]/ams"] },
  });

// ===== Mermaid fence → <div class="mermaid"> … =====
const origFence = md.renderer.rules.fence || function (tokens, idx, options, env, slf) {
  return slf.renderToken(tokens, idx, options, env, slf);
};
md.renderer.rules.fence = function (tokens, idx, options, env, slf) {
  const t = tokens[idx];
  const info = (t.info || "").trim().toLowerCase();
  if (info === "mermaid") {
    return `<div class="mermaid">\n${t.content}\n</div>\n`;
  }
  return origFence(tokens, idx, options, env, slf);
};

const bodyHtml = md.render(src);

// ===== HTML template =====
const headingNumberCSS = CFG.AUTO_NUMBER ? `
  /* 見出しの自動ナンバリング（h2〜h6）。Markdown本文に番号を書かなくても付与されます。 */
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

  /* 手動番号が既に書かれている見出しに重ねたくない場合は、クラス no-number を付ければ非表示にできます。*/
  .markdown-body h2.no-number::before,
  .markdown-body h3.no-number::before,
  .markdown-body h4.no-number::before,
  .markdown-body h5.no-number::before,
  .markdown-body h6.no-number::before { content: none; }
` : "";

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${path.basename(inPath)}</title>

<!-- GitHub Markdown CSS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown.min.css">
<!-- highlight.js (GitHubテーマ) -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">

<style>
  :root {
    --md-font-size: ${CFG.FONT_SIZE};
    --md-line-height: ${CFG.LINE_HEIGHT};
    --md-pad-x: ${CFG.PADDING_X};
    --md-pad-y: ${CFG.PADDING_Y};
    --md-code-font-scale: ${CFG.CODE_FONT_SCALE};
    --md-page-bg: ${CFG.PAGE_BG};
    --md-code-bg: ${CFG.CODE_BG};
    --md-max-width: ${CFG.MAX_WIDTH};
  }

  body {
    margin: 0;
    padding: 0;
    background: var(--md-page-bg);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  * { box-sizing: border-box; }

  .markdown-body {
    margin: 0 auto;
    padding: var(--md-pad-y) var(--md-pad-x);
    line-height: var(--md-line-height);
    font-size: var(--md-font-size);
    max-width: var(--md-max-width);
  }

  img, table, pre, code { max-width: 100%; }

  /* —— Code: wrap on both screen & print —— */
  .markdown-body pre {
    background: var(--md-code-bg);
    border-radius: 6px;
    padding: 12px 16px;
    overflow-x: visible;              /* 横スクロールを出さない */
    white-space: pre-wrap !important; /* 折り返し */
  }
  .markdown-body pre > code, .markdown-body pre code.hljs {
    white-space: pre-wrap !important;
    word-break: break-word;
    overflow-wrap: anywhere;
    display: block;
    font-size: var(--md-code-font-scale);
  }
  .markdown-body :not(pre) > code {
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  /* MathJax SVG をシャープに */
  .mjx-svg svg {
    shape-rendering: geometricPrecision;
    text-rendering: optimizeLegibility;
  }

  /* 改ページ用ユーティリティ */
  @media print {
    .page-break {
      page-break-after: always;
      break-after: page;
    }
  }

  ${headingNumberCSS}
</style>

<!-- MathJax (SVG) | Mermaid を無視させる -->
<script>
  window.MathJax = {
    options: { ignoreHtmlClass: 'mermaid' },
    tex: {
      inlineMath: [['$', '$'], ['\\(', '\\)']],
      displayMath: [['$$','$$'], ['\\[','\\]']],
      packages: { '[+]': ['ams'] }
    },
    svg: { fontCache: 'global' }
  };
</script>
<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js" id="MathJax-script"></script>

<script defer src="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/lib/highlight.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
  <div class="markdown-body">
${bodyHtml}
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', async () => {
      try {
        if (window.mermaid) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
          await mermaid.run({ querySelector: '.mermaid' });
        }
        if (window.hljs) {
          document.querySelectorAll('pre code').forEach(el => window.hljs.highlightElement(el));
        }
      } catch (e) {
        console.error('[md2html] init error:', e);
      }
    });
  </script>
</body>
</html>`;

fs.writeFileSync(outPath, html);
console.log(`✔ Generated: ${outPath} (auto numbering: ${CFG.AUTO_NUMBER ? 'ON' : 'OFF'})`);
