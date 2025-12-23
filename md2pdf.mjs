#!/usr/bin/env node
/**
 * Markdown → HTML → PDF 変換ツール（統合版）
 * - MathJax (SVG) / Mermaid / hljs / GitHub Markdown CSS 対応
 * - 見出しの自動ナンバリング（CSSカウンタ）
 * - Puppeteer により PDF も生成
 * - PDF画像のSVG変換対応（pdftocairo使用）
 *
 * 依存:
 *   npm i markdown-it markdown-it-anchor highlight.js markdown-it-mathjax3 markdown-it-github-alerts puppeteer js-yaml
 *   pdftocairo (Poppler) - PDF画像変換用: brew install poppler (macOS) / apt-get install poppler-utils (Linux)
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
import { fileURLToPath } from "url";
import { spawn } from "child_process";
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
    html: true,
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
  const { author, affiliation, student_id } = frontMatter || {};

  if (!author && !affiliation && !student_id) {
    return "";
  }

  return `
  <div class="document-meta">
    ${student_id ? `<div class="meta-student-id">学籍番号: ${student_id}</div>` : ""}
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
 * PDFをSVGに変換（pdftocairoを使用）
 * @param {string} pdfPath - PDFファイルのパス
 * @param {string} outputDir - 出力ディレクトリ
 * @param {Object} log - ロガー
 * @returns {Promise<string|null>} SVGファイルのパス、失敗時はnull
 */
async function convertPdfToSvg(pdfPath, outputDir, log) {
  const svgPath = path.join(outputDir, `${path.basename(pdfPath, ".pdf")}_${Date.now()}.svg`);

  return new Promise((resolve) => {
    const pdftocairo = spawn("pdftocairo", ["-svg", pdfPath, svgPath]);
    let stderr = "";

    pdftocairo.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pdftocairo.on("close", async (code) => {
      if (code === 0) {
        try {
          const stat = await fsp.stat(svgPath);
          if (stat.isFile()) {
            resolve(svgPath);
          } else {
            log.warn(`⚠️ PDF→SVG変換後のファイルが見つかりません: ${svgPath}`);
            resolve(null);
          }
        } catch {
          log.warn(`⚠️ PDF→SVG変換後のファイルが見つかりません: ${svgPath}`);
          resolve(null);
        }
      } else {
        log.warn(`⚠️ PDF→SVG変換失敗 (pdftocairo): ${pdfPath} (${stderr.trim() || `終了コード: ${code}`})`);
        if (stderr.includes("pdftocairo: not found") || stderr.includes("command not found")) {
          log.warn(`   💡 Popplerがインストールされていない可能性があります。インストール方法:`);
          log.warn(`      macOS: brew install poppler`);
          log.warn(`      Ubuntu/Debian: sudo apt-get install poppler-utils`);
        }
        resolve(null);
      }
    });

    pdftocairo.on("error", (error) => {
      if (error.code === "ENOENT") {
        log.warn(`⚠️ pdftocairoコマンドが見つかりません。Popplerのインストールが必要です。`);
        log.warn(`   💡 インストール方法:`);
        log.warn(`      macOS: brew install poppler`);
        log.warn(`      Ubuntu/Debian: sudo apt-get install poppler-utils`);
      } else {
        log.warn(`⚠️ PDF→SVG変換エラー: ${pdfPath} (${error.message})`);
      }
      resolve(null);
    });
  });
}

/**
 * 画像パスを処理（SVGは直接埋め込み、PNG等はBase64埋め込み）
 * @param {string} html - HTMLコンテンツ
 * @param {string} baseDir - ベースディレクトリ
 * @param {boolean} embedBase64 - Base64埋め込みフラグ（ラスター画像用）
 * @param {Object} log - ロガー
 * @returns {Promise<string>} 処理後のHTML
 */
async function processImages(html, baseDir, embedBase64, log) {
  const supportedExts = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
  const imgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/g;
  const imageMap = new Map(); // src -> { type: 'svg'|'base64'|'file', content: string, attributes: string }
  const tempFiles = []; // 一時ファイル（後で削除）

  // 画像パスを収集（属性も保持）
  const imageMatches = [];
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const beforeSrc = match[1];
    const src = match[2];
    const afterSrc = match[3];
    imageMatches.push({ fullMatch, beforeSrc, src, afterSrc });
    imageMap.set(src, null);
  }

  const tasks = [];
  const tempDir = path.join(baseDir, ".md2pdf_temp");

  // 一時ディレクトリ作成（PDF→SVG変換用）
  try {
    await fsp.mkdir(tempDir, { recursive: true });
  } catch (error) {
    log.warn(`⚠️ 一時ディレクトリ作成失敗: ${tempDir}`);
  }

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

      // PDFファイルの処理
      if (ext === "pdf") {
        if (embedBase64) {
          tasks.push(
            (async () => {
              const svgPath = await convertPdfToSvg(absPath, tempDir, log);
              if (svgPath) {
                tempFiles.push(svgPath);
                // PDFから変換したSVGのサイズをチェック
                const svgStat = await fsp.stat(svgPath);
                const svgSizeMB = svgStat.size / 1024 / 1024;

                // 1MB以上のSVGはBase64エンコード
                if (svgSizeMB > 1.0) {
                  const buffer = await fsp.readFile(svgPath);
                  const base64 = buffer.toString("base64");
                  imageMap.set(src, { type: "base64", content: `data:image/svg+xml;base64,${base64}`, attributes: "" });
                  log.info(`  📦 大きなSVGファイルをBase64エンコード: ${path.basename(svgPath)} (${svgSizeMB.toFixed(2)}MB)`);
                } else {
                  // 1MB以下のSVGは直接埋め込む
                  const svgContent = await fsp.readFile(svgPath, "utf8");
                  imageMap.set(src, { type: "svg", content: svgContent, attributes: "" });
                }
              } else {
                imageMap.delete(src);
              }
            })()
          );
        } else {
          // file:// の場合はPDFをそのまま使用（ただし、ブラウザで表示できない可能性あり）
          log.warn(`⚠️ PDFファイルはBase64埋め込み推奨: ${absPath}`);
          const fileUrl = new URL(`file://${absPath}`);
          imageMap.set(src, { type: "file", content: fileUrl.href, attributes: "" });
        }
        continue;
      }

      if (!supportedExts.has(ext)) {
        log.warn(`⚠️ サポートされていない画像形式: ${ext}`);
        continue;
      }

      // SVGファイルの処理（サイズに応じて直接埋め込み or Base64エンコード）
      if (ext === "svg") {
        const fileSizeMB = stat.size / 1024 / 1024;

        // 1MB以上のSVGファイルはBase64エンコード（HTMLサイズを抑えるため）
        if (fileSizeMB > 1.0) {
          if (embedBase64) {
            tasks.push(
              fsp.readFile(absPath).then((buffer) => {
                const base64 = buffer.toString("base64");
                imageMap.set(src, { type: "base64", content: `data:image/svg+xml;base64,${base64}`, attributes: "" });
                log.info(`  📦 大きなSVGファイルをBase64エンコード: ${path.basename(absPath)} (${fileSizeMB.toFixed(2)}MB)`);
              })
            );
          } else {
            // file:// プロトコル付き絶対パス
            const fileUrl = new URL(`file://${absPath}`);
            imageMap.set(src, { type: "file", content: fileUrl.href, attributes: "" });
          }
        } else {
          // 1MB以下のSVGファイルは直接HTMLに埋め込む
          tasks.push(
            fsp.readFile(absPath, "utf8").then((svgContent) => {
              imageMap.set(src, { type: "svg", content: svgContent, attributes: "" });
            })
          );
        }
      } else if (embedBase64) {
        // PNG等のラスター画像はBase64エンコード
        tasks.push(
          fsp.readFile(absPath).then((buffer) => {
            const mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
            const base64 = buffer.toString("base64");
            imageMap.set(src, { type: "base64", content: `data:${mimeType};base64,${base64}`, attributes: "" });
          })
        );
      } else {
        // file:// プロトコル付き絶対パス
        const fileUrl = new URL(`file://${absPath}`);
        imageMap.set(src, { type: "file", content: fileUrl.href, attributes: "" });
      }
    } catch (error) {
      log.warn(`⚠️ 画像処理失敗: ${absPath} (${error.message})`);
    }
  }

  // すべての画像処理を並行実行
  await Promise.all(tasks);

  // 画像を置換
  let result = html;
  for (const { fullMatch, beforeSrc, src, afterSrc } of imageMatches) {
    const imageInfo = imageMap.get(src);
    if (!imageInfo) {
      continue; // 処理されなかった画像はそのまま
    }

    if (imageInfo.type === "svg") {
      // SVGは直接埋め込む（元のimgタグの属性を適切に処理）
      const allAttributes = `${beforeSrc}${afterSrc}`.trim();

      // 属性を解析
      const attrMap = new Map();
      const attrRegex = /(\w+)=["']([^"']+)["']/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(allAttributes)) !== null) {
        attrMap.set(attrMatch[1].toLowerCase(), attrMatch[2]);
      }

      let svgContent = imageInfo.content;

      // width/height属性をSVGに適用
      if (attrMap.has("width")) {
        svgContent = svgContent.replace(/<svg([^>]*?)>/i, (match, attrs) => {
          if (!/width\s*=/i.test(attrs)) {
            return `<svg${attrs} width="${attrMap.get("width")}">`;
          }
          return match;
        });
      }
      if (attrMap.has("height")) {
        svgContent = svgContent.replace(/<svg([^>]*?)>/i, (match, attrs) => {
          if (!/height\s*=/i.test(attrs)) {
            return `<svg${attrs} height="${attrMap.get("height")}">`;
          }
          return match;
        });
      }

      // alt属性をtitle要素として追加
      if (attrMap.has("alt")) {
        const altText = attrMap.get("alt");
        if (!/<title>/i.test(svgContent)) {
          svgContent = svgContent.replace(/<svg([^>]*?)>/i, `<svg$1><title>${altText}</title>`);
        }
      }

      // class、styleなどのその他の属性をSVGタグに適用
      const otherAttrs = [];
      for (const [key, value] of attrMap.entries()) {
        if (!["width", "height", "alt", "src"].includes(key)) {
          otherAttrs.push(`${key}="${value}"`);
        }
      }
      if (otherAttrs.length > 0) {
        svgContent = svgContent.replace(/<svg([^>]*?)>/i, (match, attrs) => {
          return `<svg${attrs} ${otherAttrs.join(" ")}>`;
        });
      }

      result = result.replace(fullMatch, svgContent);
    } else {
      // Base64またはfile://の場合はsrc属性を置換
      result = result.replace(fullMatch, `<img${beforeSrc}src="${imageInfo.content}"${afterSrc}>`);
    }
  }

  // 一時ファイルを削除
  for (const tempFile of tempFiles) {
    try {
      await fsp.unlink(tempFile);
    } catch (error) {
      log.warn(`⚠️ 一時ファイル削除失敗: ${tempFile}`);
    }
  }

  // 一時ディレクトリを削除（空の場合）
  try {
    const files = await fsp.readdir(tempDir);
    if (files.length === 0) {
      await fsp.rmdir(tempDir);
    }
  } catch {
    // エラーは無視
  }

  const svgCount = Array.from(imageMap.values()).filter(v => v && v.type === "svg").length;
  const base64Count = Array.from(imageMap.values()).filter(v => v && v.type === "base64").length;
  const pdfCount = Array.from(imageMap.keys()).filter(s => s.toLowerCase().endsWith(".pdf")).length;
  if (imageMap.size > 0) {
    const parts = [];
    if (svgCount > 0) parts.push(`SVG直接埋め込み: ${svgCount}個`);
    if (base64Count > 0) parts.push(`Base64変換: ${base64Count}個`);
    if (pdfCount > 0) parts.push(`PDF→SVG変換: ${pdfCount}個`);
    const msg = parts.length > 0 ? `、${parts.join("、")}` : "";
    log.info(`🖼️  画像処理: ${imageMap.size}個の画像を検出${msg}`);
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
 * @param {{title: string, body: string, cfg: Object, autoNumber: boolean|undefined}} params
 * @returns {string} 完全なHTML
 */
function buildHtml({ title, body, cfg, autoNumber }) {
  const enableNumbering = autoNumber !== undefined ? autoNumber : cfg.AUTO_NUMBER;
  const headingNumberCSS = buildHeadingNumberCSS(enableNumbering);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "template.html"),
    path.join(scriptDir, "template.html"),
  ];
  let tmpl = null;
  for (const p of candidates) {
    try {
      tmpl = fs.readFileSync(p, "utf8");
      break;
    } catch {}
  }
  if (!tmpl) {
    throw new Error("template.html が見つかりません。プロジェクト直下またはスクリプトと同階層に配置してください。");
  }

  return tmpl
    .replace(/\/\*\{\{HEADING_NUMBER_CSS\}\}\*\//g, headingNumberCSS)
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{BODY\}\}/g, body)
    .replace(/\{\{FONT_SIZE\}\}/g, cfg.FONT_SIZE)
    .replace(/\{\{LINE_HEIGHT\}\}/g, cfg.LINE_HEIGHT)
    .replace(/\{\{PADDING_X\}\}/g, cfg.PADDING_X)
    .replace(/\{\{PADDING_Y\}\}/g, cfg.PADDING_Y)
    .replace(/\{\{CODE_FONT_SCALE\}\}/g, cfg.CODE_FONT_SCALE)
    .replace(/\{\{PAGE_BG\}\}/g, cfg.PAGE_BG)
    .replace(/\{\{CODE_BG\}\}/g, cfg.CODE_BG)
    .replace(/\{\{MAX_WIDTH\}\}/g, cfg.MAX_WIDTH);
}

// ========================================
// PDF生成関数
// ========================================

/**
 * PuppeteerでPDFを生成
 * @param {{html: string|null, htmlPath: string|null, pdfPath: string, cfg: Object, dateStr: string}} params
 */
async function renderPDF({ html, htmlPath, pdfPath, cfg, dateStr }) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // メモリ不足対策
      "--disable-gpu", // GPU無効化（メモリ節約）
      "--max-old-space-size=4096" // Node.jsのメモリ制限（ただし、これはブラウザには効かない）
    ]
  });

  let page = null;
  let pageClosed = false;

  try {
    page = await browser.newPage();

    // ページが閉じられた場合のフラグ設定
    page.on("close", () => {
      pageClosed = true;
    });

    // ページエラーのハンドリング
    page.on("error", (error) => {
      console.warn(`⚠️ ページエラー: ${error.message}`);
    });

    // Base64埋め込み画像の場合、networkidle0は適さないため、loadを使用
    try {
      if (htmlPath) {
        const fileUrl = new URL(`file://${htmlPath}`);
        await page.goto(fileUrl.href, { waitUntil: "load", timeout: 120000 });
      } else if (html) {
        // HTMLサイズをチェック（デバッグ用）
        const htmlSizeMB = (html.length / 1024 / 1024).toFixed(2);
        if (htmlSizeMB > 10) {
          console.warn(`⚠️ HTMLサイズが大きいです: ${htmlSizeMB}MB`);
        }
        await page.setContent(html, { waitUntil: "load", timeout: 120000 });
      } else {
        throw new Error("HTMLコンテンツまたはHTMLファイルパスが必要です");
      }
    } catch (error) {
      if (pageClosed || page.isClosed()) {
        throw new Error(`ページが閉じられました（HTML読み込み中）: ${error.message}`);
      }
      throw new Error(`HTML読み込みエラー: ${error.message}`);
    }

    // ページが閉じられていないか確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています");
    }

    // DOMの読み込み完了を待つ
    try {
      await page.waitForFunction(() => document.readyState === "complete", { timeout: 30000 });
    } catch (error) {
      if (pageClosed || page.isClosed()) {
        throw new Error("ページが閉じられました（DOM読み込み待機中）");
      }
      throw error;
    }

    // ページが閉じられていないか確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています（DOM読み込み後）");
    }

    // 画像の読み込み完了を待つ（Base64埋め込み画像とSVG要素も含む）
    try {
      await page.evaluate(() => {
        const promises = [];

        // <img>タグの読み込み待機
        Array.from(document.querySelectorAll("img")).forEach((img) => {
          if (img.complete) return;
          promises.push(
            new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve; // エラーでも続行
              setTimeout(resolve, 5000); // タイムアウト
            })
          );
        });

        // SVG要素の読み込み待機（直接埋め込まれたSVG）
        Array.from(document.querySelectorAll("svg")).forEach((svg) => {
          // SVGは既にDOMに存在するので、すぐに解決
          // ただし、SVG内の画像要素を待つ
          Array.from(svg.querySelectorAll("image")).forEach((img) => {
            if (img.complete) return;
            promises.push(
              new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 5000);
              })
            );
          });
        });

        return Promise.all(promises);
      });
    } catch (error) {
      if (pageClosed || page.isClosed()) {
        throw new Error("ページが閉じられました（画像読み込み待機中）");
      }
      // 画像読み込みエラーは警告として記録し、処理を続行
      console.warn(`⚠️ 画像読み込み処理中にエラーが発生しましたが、処理を続行します: ${error.message}`);
    }

    // ページが閉じられていないか確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています（画像読み込み後）");
    }

    // MathJax/Mermaid のレンダリングを待機（エラーハンドリング付き）
    try {
      await page.evaluate(async () => {
        // Mermaid のレンダリング
        if (window.mermaid) {
          try {
            const mermaidElements = document.querySelectorAll(".mermaid");
            if (mermaidElements.length > 0) {
              await mermaid.run({ querySelector: ".mermaid" });
            }
          } catch (error) {
            console.warn("Mermaid レンダリングエラー:", error);
          }
        }

        // MathJax のレンダリング
        if (window.MathJax && MathJax.typesetPromise) {
          try {
            await MathJax.typesetPromise();
          } catch (error) {
            console.warn("MathJax レンダリングエラー:", error);
          }
        }
      });
    } catch (error) {
      if (pageClosed || page.isClosed()) {
        throw new Error("ページが閉じられました（MathJax/Mermaidレンダリング中）");
      }
      // レンダリングエラーは警告として記録し、処理を続行
      console.warn(`⚠️ レンダリング処理中にエラーが発生しましたが、処理を続行します: ${error.message}`);
    }

    // ページが閉じられていないか確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています（レンダリング後）");
    }

    // レンダリング完了後に少し待機（レイアウトの安定化）
    await new Promise(resolve => setTimeout(resolve, 500));

    // ページが閉じられていないか最終確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています（最終確認）");
    }

    // PDF生成前にページが閉じられていないか確認
    if (pageClosed || page.isClosed()) {
      throw new Error("ページが閉じられています（PDF生成前）");
    }

    try {
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
        timeout: 120000, // タイムアウトを120秒に延長
      });
    } catch (error) {
      if (pageClosed || page.isClosed()) {
        throw new Error(`ページが閉じられました（PDF生成中）: ${error.message}`);
      }
      throw error;
    }
  } catch (error) {
    // エラーを再スローして、上位で処理
    throw error;
  } finally {
    // ページが開いている場合のみ閉じる
    if (page && !page.isClosed() && !pageClosed) {
      try {
        await page.close();
      } catch (error) {
        // ページが既に閉じられている場合は無視
      }
    }
    try {
      await browser.close();
    } catch (error) {
      // ブラウザが既に閉じられている場合は無視
    }
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
    log.info(`📋 モード: ${cfg.SAVE_HTML ? 'HTML保存あり（Base64埋め込み画像）' : 'HTML保存なし（Base64埋め込み画像）'}`);

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
      true,
      log
    );

    // メタ情報挿入
    const metaInfo = generateMetaInfo(frontMatter);
    const finalBodyHtml = insertAfterFirstH1(processedBodyHtml, metaInfo);

    // YAMLフロントマターから見出しナンバリング設定を取得
    const autoNumber = frontMatter.auto_number !== undefined
      ? frontMatter.auto_number !== false && frontMatter.auto_number !== "false"
      : undefined;

    // HTML全体組み立て
    const html = buildHtml({ title: baseName, body: finalBodyHtml, cfg, autoNumber });
    log.info("✅ HTML生成完了");

    // HTMLサイズをチェック
    const htmlSizeMB = html.length / 1024 / 1024;
    let tempHtmlPath = null;

    // HTML保存（必要に応じて、または大きい場合は一時ファイルとして保存）
    if (cfg.SAVE_HTML) {
      await fsp.mkdir(path.dirname(htmlOut), { recursive: true });
      await fsp.writeFile(htmlOut, html);
      log.always(`✔ HTML generated: ${htmlOut}`);
      tempHtmlPath = path.resolve(htmlOut);
    } else if (htmlSizeMB > 50.0) {
      // 50MB以上のHTMLは一時ファイルに保存してから読み込む（メモリ節約）
      const tempDir = path.join(path.dirname(path.resolve(inPath)), ".md2pdf_temp");
      await fsp.mkdir(tempDir, { recursive: true });
      tempHtmlPath = path.join(tempDir, `${baseName}_${Date.now()}.html`);
      await fsp.writeFile(tempHtmlPath, html);
      log.info(`📦 大きなHTMLを一時ファイルに保存: ${htmlSizeMB.toFixed(2)}MB`);
    }

    // PDF生成
    const dateStr = frontMatter.date
      ? new Date(frontMatter.date).toLocaleDateString("ja-JP")
      : new Date().toLocaleDateString("ja-JP");

    log.info("🌐 Puppeteer起動中...");
    if (tempHtmlPath) {
      log.info(`📄 HTMLファイルから読み込み中: ${path.basename(tempHtmlPath)}`);
    } else {
      log.info("📄 HTMLをメモリから読み込み中...");
    }
    log.info("⏳ MathJax/Mermaid レンダリング待機中...");
    log.info("📄 PDF生成中...");

    try {
      await renderPDF({
        html: tempHtmlPath ? null : html, // 一時ファイルがある場合はnull
        htmlPath: tempHtmlPath,
        pdfPath: pdfOut,
        cfg,
        dateStr,
      });
    } finally {
      // 一時HTMLファイルを削除
      if (tempHtmlPath && !cfg.SAVE_HTML) {
        try {
          await fsp.unlink(tempHtmlPath);
        } catch (error) {
          log.warn(`⚠️ 一時HTMLファイル削除失敗: ${tempHtmlPath}`);
        }
      }
    }

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
