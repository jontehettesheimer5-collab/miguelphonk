import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import axios from "axios";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN environment variable is missing.");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const commands = [
  new SlashCommandBuilder().setName("hmtl").setDescription("Fetches the full HTML source of a URL as a .txt file")
    .addStringOption(o => o.setName("link").setDescription("The URL to fetch").setRequired(true)),
  new SlashCommandBuilder().setName("java").setDescription("Extracts all JavaScript (external + inline) from a URL")
    .addStringOption(o => o.setName("link").setDescription("The URL to extract JavaScript from").setRequired(true)),
  new SlashCommandBuilder().setName("css").setDescription("Extracts all CSS (external + inline) from a URL")
    .addStringOption(o => o.setName("link").setDescription("The URL to extract CSS from").setRequired(true)),
  new SlashCommandBuilder().setName("assets").setDescription("Lists all asset URLs (images, fonts, videos, icons, audio) on a page")
    .addStringOption(o => o.setName("link").setDescription("The URL to scan for assets").setRequired(true)),
  new SlashCommandBuilder().setName("full").setDescription("Returns all 4 files at once: HTML source, JavaScript, CSS, and asset list")
    .addStringOption(o => o.setName("link").setDescription("The URL to fully extract").setRequired(true)),
].map(c => c.toJSON());

function validateUrl(link) {
  try {
    const u = new URL(link);
    return (u.protocol === "http:" || u.protocol === "https:") ? u : null;
  } catch { return null; }
}

async function fetchText(url, timeoutMs = 15000) {
  const res = await axios.get(url, {
    responseType: "text", timeout: timeoutMs,
    maxContentLength: 8 * 1024 * 1024, headers: HEADERS,
  });
  return res.data;
}

function errMsg(err) {
  if (axios.isAxiosError(err)) {
    if (err.code === "ECONNABORTED") return "❌ Timeout — server did not respond in time.";
    if (err.response) return `❌ HTTP error \`${err.response.status}\`.`;
    return `❌ Connection error: \`${err.message}\``;
  }
  return "❌ Unknown error.";
}

const LIMIT = 8 * 1024 * 1024;

function attach(buf, name) {
  return buf.byteLength <= LIMIT ? new AttachmentBuilder(buf, { name }) : null;
}

// ── /hmtl ────────────────────────────────────────────────────────────────────
async function handleHmtl(interaction) {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();
  const url = validateUrl(link);
  if (!url) return interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
  try {
    const html = await fetchText(link);
    const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const buf = Buffer.from(html, "utf-8");
    if (buf.byteLength > LIMIT) return interaction.editReply("❌ Page is too large (max 8 MB).");
    await interaction.editReply({ content: `✅ HTML source of \`${link}\` (${(buf.byteLength/1024).toFixed(1)} KB)`, files: [new AttachmentBuilder(buf, { name: `${host}_source.txt` })] });
  } catch (e) { await interaction.editReply(errMsg(e)); }
}

// ── shared extraction helpers ─────────────────────────────────────────────────
function extractScriptSrcs(html, baseUrl) {
  const srcs = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi))
    try { srcs.push(new URL(m[1], baseUrl).href); } catch {}
  return srcs;
}
function extractInlineScripts(html) {
  const r = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const c = m[1].trim(); if (c) r.push(c);
  }
  return r;
}
function extractStylesheetHrefs(html, baseUrl) {
  const r = [];
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const h = m[0].match(/href=["']([^"']+)["']/i);
    if (h) try { r.push(new URL(h[1], baseUrl).href); } catch {}
  }
  return r;
}
function extractInlineStyles(html) {
  const r = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const c = m[1].trim(); if (c) r.push(c);
  }
  return r;
}
function extractAssets(html, baseUrl) {
  const assets = { images: [], videos: [], audio: [], fonts: [], icons: [], other: [] };
  function resolve(raw) { try { return new URL(raw, baseUrl).href; } catch { return null; } }
  function classify(u) {
    const l = u.toLowerCase().split("?")[0];
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)(\b|$)/.test(l)) return "images";
    if (/\.(mp4|webm|ogv|mov|avi|mkv)(\b|$)/.test(l)) return "videos";
    if (/\.(mp3|ogg|wav|flac|aac|m4a)(\b|$)/.test(l)) return "audio";
    if (/\.(woff2?|ttf|otf|eot)(\b|$)/.test(l)) return "fonts";
    if (/favicon|\.ico(\b|$)/.test(l)) return "icons";
    return "other";
  }
  function add(raw) {
    if (!raw || raw.startsWith("data:")) return;
    const r = resolve(raw.trim()); if (!r) return;
    const cat = classify(r); if (!assets[cat].includes(r)) assets[cat].push(r);
  }
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<img[^>]+srcset=["']([^"']+)["']/gi)) m[1].split(",").forEach(p => add(p.trim().split(/\s+/)[0]));
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<source[^>]+srcset=["']([^"']+)["']/gi)) m[1].split(",").forEach(p => add(p.trim().split(/\s+/)[0]));
  for (const m of html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<audio[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0], h = tag.match(/href=["']([^"']+)["']/i); if (!h) continue;
    const rel = (tag.match(/rel=["']([^"']+)["']/i)||[])[1]||"";
    const as_ = (tag.match(/\bas=["']([^"']+)["']/i)||[])[1]||"";
    if (/icon|apple-touch-icon/.test(rel)) add(h[1]);
    else if (rel === "preload" && (as_ === "font" || as_ === "image")) add(h[1]);
  }
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);
  return assets;
}

// ── buffer builders ───────────────────────────────────────────────────────────
async function buildJsBuf(html, baseUrl) {
  const srcs = extractScriptSrcs(html, baseUrl), inline = extractInlineScripts(html);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines = [sep, `JS EXTRACTION — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`,
    `External JS files: ${srcs.length}`, `Inline scripts: ${inline.length}`, sep, ""];
  if (inline.length) { lines.push(div, `INLINE SCRIPTS (${inline.length})`, div, ""); inline.forEach((s,i) => lines.push(`// ── Inline #${i+1} ──`, s, "")); }
  if (srcs.length) {
    lines.push(div, `EXTERNAL JS FILES (${srcs.length})`, div, "");
    for (let i = 0; i < srcs.length; i++) {
      lines.push(`// ── File #${i+1}: ${srcs[i]} ──`);
      try { lines.push(await fetchText(srcs[i], 10000), ""); } catch (e) { lines.push(`// ⚠ Could not load: ${errMsg(e)}`, ""); }
    }
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}
async function buildCssBuf(html, baseUrl) {
  const hrefs = extractStylesheetHrefs(html, baseUrl), inline = extractInlineStyles(html);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines = [sep, `CSS EXTRACTION — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`,
    `External stylesheets: ${hrefs.length}`, `Inline styles: ${inline.length}`, sep, ""];
  if (inline.length) { lines.push(div, `INLINE STYLES (${inline.length})`, div, ""); inline.forEach((s,i) => lines.push(`/* ── Inline #${i+1} ── */`, s, "")); }
  if (hrefs.length) {
    lines.push(div, `EXTERNAL STYLESHEETS (${hrefs.length})`, div, "");
    for (let i = 0; i < hrefs.length; i++) {
      lines.push(`/* ── File #${i+1}: ${hrefs[i]} ── */`);
      try { lines.push(await fetchText(hrefs[i], 10000), ""); } catch (e) { lines.push(`/* ⚠ Could not load: ${errMsg(e)} */`, ""); }
    }
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}
function buildAssetsBuf(html, baseUrl) {
  const assets = extractAssets(html, baseUrl);
  const total = Object.values(assets).reduce((a, b) => a + b.length, 0);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines = [sep, `ASSET SCAN — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`, `Total assets: ${total}`,
    `  Images: ${assets.images.length}  Videos: ${assets.videos.length}  Audio: ${assets.audio.length}`,
    `  Fonts:  ${assets.fonts.length}   Icons:  ${assets.icons.length}   Other: ${assets.other.length}`, sep, ""];
  for (const [key, label] of [["images","IMAGES"],["videos","VIDEOS"],["audio","AUDIO"],["fonts","FONTS"],["icons","ICONS"],["other","OTHER"]]) {
    if (!assets[key].length) continue;
    lines.push(div, `${label} (${assets[key].length})`, div, "");
    assets[key].forEach((u, i) => lines.push(`${i+1}. ${u}`));
    lines.push("");
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

// ── /java ────────────────────────────────────────────────────────────────────
async function handleJava(interaction) {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();
  const url = validateUrl(link);
  if (!url) return interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
  try {
    await interaction.editReply("⏳ Fetching page and extracting JavaScript...");
    const html = await fetchText(link);
    const srcs = extractScriptSrcs(html, url), inline = extractInlineScripts(html);
    if (!srcs.length && !inline.length) return interaction.editReply("ℹ️ No JavaScript found on this page.");
    const buf = await buildJsBuf(html, url);
    const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    if (buf.byteLength > LIMIT) {
      const fb = Buffer.from([`JS EXTRACTION (truncated) — ${link}`, "Too large. Script URLs:", "", ...srcs.map((s,i)=>`${i+1}. ${s}`)].join("\n"), "utf-8");
      return interaction.editReply({ content: "⚠️ Too large — script URL list:", files: [new AttachmentBuilder(fb, { name: `${host}_scripts_urls.txt` })] });
    }
    await interaction.editReply({ content: `✅ JavaScript from \`${link}\` — ${srcs.length} file(s), ${inline.length} inline (${(buf.byteLength/1024).toFixed(1)} KB)`, files: [new AttachmentBuilder(buf, { name: `${host}_scripts.txt` })] });
  } catch (e) { await interaction.editReply(errMsg(e)); }
}

// ── /css ─────────────────────────────────────────────────────────────────────
async function handleCss(interaction) {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();
  const url = validateUrl(link);
  if (!url) return interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
  try {
    await interaction.editReply("⏳ Fetching page and extracting CSS...");
    const html = await fetchText(link);
    const hrefs = extractStylesheetHrefs(html, url), inline = extractInlineStyles(html);
    if (!hrefs.length && !inline.length) return interaction.editReply("ℹ️ No CSS found on this page.");
    const buf = await buildCssBuf(html, url);
    const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    if (buf.byteLength > LIMIT) {
      const fb = Buffer.from([`CSS EXTRACTION (truncated) — ${link}`, "Too large. Stylesheet URLs:", "", ...hrefs.map((s,i)=>`${i+1}. ${s}`)].join("\n"), "utf-8");
      return interaction.editReply({ content: "⚠️ Too large — stylesheet URL list:", files: [new AttachmentBuilder(fb, { name: `${host}_styles_urls.txt` })] });
    }
    await interaction.editReply({ content: `✅ CSS from \`${link}\` — ${hrefs.length} stylesheet(s), ${inline.length} inline (${(buf.byteLength/1024).toFixed(1)} KB)`, files: [new AttachmentBuilder(buf, { name: `${host}_styles.txt` })] });
  } catch (e) { await interaction.editReply(errMsg(e)); }
}

// ── /assets ──────────────────────────────────────────────────────────────────
async function handleAssets(interaction) {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();
  const url = validateUrl(link);
  if (!url) return interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
  try {
    await interaction.editReply("⏳ Scanning page for assets...");
    const html = await fetchText(link);
    const assets = extractAssets(html, url);
    const total = Object.values(assets).reduce((a, b) => a + b.length, 0);
    if (!total) return interaction.editReply("ℹ️ No assets found on this page.");
    const buf = buildAssetsBuf(html, url);
    const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    await interaction.editReply({ content: `✅ Assets from \`${link}\` — ${total} total (${assets.images.length} img, ${assets.fonts.length} font, ${assets.videos.length} vid, ${assets.audio.length} audio, ${assets.icons.length} icon, ${assets.other.length} other)`, files: [new AttachmentBuilder(buf, { name: `${host}_assets.txt` })] });
  } catch (e) { await interaction.editReply(errMsg(e)); }
}

// ── /full ────────────────────────────────────────────────────────────────────
async function handleFull(interaction) {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();
  const url = validateUrl(link);
  if (!url) return interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
  try {
    await interaction.editReply("⏳ Fetching page — extracting HTML, JS, CSS and assets...");
    const html = await fetchText(link);
    const host = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");

    const [jsBuf, cssBuf] = await Promise.all([buildJsBuf(html, url), buildCssBuf(html, url)]);
    const htmlBuf = Buffer.from(html, "utf-8");
    const assetsBuf = buildAssetsBuf(html, url);

    const files = [], notes = [];
    for (const [buf, name] of [[htmlBuf, `${host}_source.txt`], [jsBuf, `${host}_scripts.txt`], [cssBuf, `${host}_styles.txt`], [assetsBuf, `${host}_assets.txt`]]) {
      const a = attach(buf, name);
      if (a) files.push(a); else notes.push(name.replace(`${host}_`, "").replace(".txt", ""));
    }

    const warning = notes.length ? ` ⚠️ Skipped (too large): ${notes.join(", ")}.` : "";
    await interaction.editReply({ content: `✅ Full extraction of \`${link}\` — ${files.length}/4 files attached.${warning}`, files });
  } catch (e) { await interaction.editReply(errMsg(e)); }
}

// ── Start ────────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async (c) => {
  console.log(`[Bot] Logged in as ${c.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log("[Bot] Slash commands registered.");
  const perms = 1024 + 2048 + 32768;
  console.log(`[Bot] Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&permissions=${perms}&scope=bot%20applications.commands`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "hmtl")   await handleHmtl(interaction);
  if (interaction.commandName === "java")   await handleJava(interaction);
  if (interaction.commandName === "css")    await handleCss(interaction);
  if (interaction.commandName === "assets") await handleAssets(interaction);
  if (interaction.commandName === "full")   await handleFull(interaction);
});

client.on("error", (err) => console.error("[Bot] Error:", err));
client.login(token);
