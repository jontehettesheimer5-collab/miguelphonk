import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import axios from "axios";
import { logger } from "./lib/logger";

const token = process.env["DISCORD_TOKEN"];

if (!token) {
  throw new Error("DISCORD_TOKEN environment variable is required but was not provided.");
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const commands = [
  new SlashCommandBuilder()
    .setName("hmtl")
    .setDescription("Fetches the full HTML source of a URL and returns it as a .txt file")
    .addStringOption((o) =>
      o.setName("link").setDescription("The URL to fetch").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("java")
    .setDescription("Extracts all JavaScript (external files + inline scripts) from a URL")
    .addStringOption((o) =>
      o.setName("link").setDescription("The URL to extract JavaScript from").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("css")
    .setDescription("Extracts all CSS (external stylesheets + inline styles) from a URL")
    .addStringOption((o) =>
      o.setName("link").setDescription("The URL to extract CSS from").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("assets")
    .setDescription("Lists all asset URLs (images, fonts, videos, icons, audio) found on a page")
    .addStringOption((o) =>
      o.setName("link").setDescription("The URL to scan for assets").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("full")
    .setDescription("Returns all 4 files at once: HTML source, JavaScript, CSS, and asset list")
    .addStringOption((o) =>
      o.setName("link").setDescription("The URL to fully extract").setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token!);
  logger.info("Registering slash commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Slash commands registered successfully.");
}

function validateUrl(link: string): URL | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const res = await axios.get<string>(url, {
    responseType: "text",
    timeout: timeoutMs,
    maxContentLength: 8 * 1024 * 1024,
    headers: HEADERS,
  });
  return res.data;
}

function axiosErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === "ECONNABORTED") return "❌ Timeout — the server did not respond in time.";
    if (err.response) return `❌ HTTP error \`${err.response.status}\` while fetching the URL.`;
    return `❌ Connection error: \`${err.message}\``;
  }
  return "❌ Unknown error.";
}

// ─── /hmtl ───────────────────────────────────────────────────────────────────

async function handleHmtl(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
    return;
  }

  try {
    const html = await fetchText(link);
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const buffer = Buffer.from(html, "utf-8");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      await interaction.editReply("❌ Page is too large (max 8 MB).");
      return;
    }

    await interaction.editReply({
      content: `✅ HTML source of \`${link}\` (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_source.txt` })],
    });

    logger.info({ url: link, size: buffer.byteLength }, "/hmtl success");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── /java ───────────────────────────────────────────────────────────────────

function extractScriptSrcs(html: string, baseUrl: URL): string[] {
  const srcs: string[] = [];
  const srcRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = srcRegex.exec(html)) !== null) {
    try { srcs.push(new URL(match[1], baseUrl).href); } catch { /* skip */ }
  }
  return srcs;
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const inlineRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = inlineRegex.exec(html)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) scripts.push(content);
  }
  return scripts;
}

async function handleJava(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
    return;
  }

  try {
    await interaction.editReply("⏳ Fetching page and extracting JavaScript...");

    const html = await fetchText(link);
    const scriptSrcs = extractScriptSrcs(html, url);
    const inlineScripts = extractInlineScripts(html);

    if (inlineScripts.length === 0 && scriptSrcs.length === 0) {
      await interaction.editReply("ℹ️ No JavaScript found on this page.");
      return;
    }

    const sep = "═".repeat(80);
    const div = "─".repeat(80);
    const lines: string[] = [
      sep,
      `JS EXTRACTION — ${link}`,
      `Generated: ${new Date().toISOString()}`,
      `External JS files found: ${scriptSrcs.length}`,
      `Inline scripts found:    ${inlineScripts.length}`,
      sep, "",
    ];

    if (inlineScripts.length > 0) {
      lines.push(div, `INLINE SCRIPTS (${inlineScripts.length})`, div, "");
      inlineScripts.forEach((s, i) => lines.push(`// ── Inline Script #${i + 1} ──`, s, ""));
    }

    if (scriptSrcs.length > 0) {
      lines.push(div, `EXTERNAL JS FILES (${scriptSrcs.length})`, div, "");
      for (let i = 0; i < scriptSrcs.length; i++) {
        lines.push(`// ── File #${i + 1}: ${scriptSrcs[i]} ──`);
        try { lines.push(await fetchText(scriptSrcs[i], 10000), ""); }
        catch (err) { lines.push(`// ⚠ Could not load: ${axiosErrorMessage(err)}`, ""); }
      }
    }

    const buffer = Buffer.from(lines.join("\n"), "utf-8");
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      const fallback = [
        `JS EXTRACTION (truncated) — ${link}`,
        "Full content too large for Discord. Listing script URLs only.",
        "", `Script URLs (${scriptSrcs.length}):`,
        ...scriptSrcs.map((s, i) => `${i + 1}. ${s}`),
      ].join("\n");
      await interaction.editReply({
        content: `⚠️ Full content too large — script URL list from \`${link}\``,
        files: [new AttachmentBuilder(Buffer.from(fallback, "utf-8"), { name: `${hostname}_scripts_urls.txt` })],
      });
      return;
    }

    await interaction.editReply({
      content: `✅ JavaScript from \`${link}\` — ${scriptSrcs.length} external file(s), ${inlineScripts.length} inline script(s) (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_scripts.txt` })],
    });

    logger.info({ url: link, external: scriptSrcs.length, inline: inlineScripts.length }, "/java success");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── /css ────────────────────────────────────────────────────────────────────

function extractStylesheetHrefs(html: string, baseUrl: URL): string[] {
  const hrefs: string[] = [];
  const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
  const hrefRegex = /href=["']([^"']+)["']/i;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const hrefMatch = hrefRegex.exec(match[0]);
    if (hrefMatch) {
      try { hrefs.push(new URL(hrefMatch[1], baseUrl).href); } catch { /* skip */ }
    }
  }
  return hrefs;
}

function extractInlineStyles(html: string): string[] {
  const styles: string[] = [];
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = styleRegex.exec(html)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) styles.push(content);
  }
  return styles;
}

async function handleCss(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
    return;
  }

  try {
    await interaction.editReply("⏳ Fetching page and extracting CSS...");

    const html = await fetchText(link);
    const stylesheetHrefs = extractStylesheetHrefs(html, url);
    const inlineStyles = extractInlineStyles(html);

    if (inlineStyles.length === 0 && stylesheetHrefs.length === 0) {
      await interaction.editReply("ℹ️ No CSS found on this page.");
      return;
    }

    const sep = "═".repeat(80);
    const div = "─".repeat(80);
    const lines: string[] = [
      sep,
      `CSS EXTRACTION — ${link}`,
      `Generated: ${new Date().toISOString()}`,
      `External stylesheets found: ${stylesheetHrefs.length}`,
      `Inline styles found:        ${inlineStyles.length}`,
      sep, "",
    ];

    if (inlineStyles.length > 0) {
      lines.push(div, `INLINE STYLES (${inlineStyles.length})`, div, "");
      inlineStyles.forEach((s, i) => lines.push(`/* ── Inline Style #${i + 1} ── */`, s, ""));
    }

    if (stylesheetHrefs.length > 0) {
      lines.push(div, `EXTERNAL STYLESHEETS (${stylesheetHrefs.length})`, div, "");
      for (let i = 0; i < stylesheetHrefs.length; i++) {
        lines.push(`/* ── File #${i + 1}: ${stylesheetHrefs[i]} ── */`);
        try { lines.push(await fetchText(stylesheetHrefs[i], 10000), ""); }
        catch (err) { lines.push(`/* ⚠ Could not load: ${axiosErrorMessage(err)} */`, ""); }
      }
    }

    const buffer = Buffer.from(lines.join("\n"), "utf-8");
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      const fallback = [
        `CSS EXTRACTION (truncated) — ${link}`,
        "Full content too large for Discord. Listing stylesheet URLs only.",
        "", `Stylesheet URLs (${stylesheetHrefs.length}):`,
        ...stylesheetHrefs.map((s, i) => `${i + 1}. ${s}`),
      ].join("\n");
      await interaction.editReply({
        content: `⚠️ Full content too large — stylesheet URL list from \`${link}\``,
        files: [new AttachmentBuilder(Buffer.from(fallback, "utf-8"), { name: `${hostname}_styles_urls.txt` })],
      });
      return;
    }

    await interaction.editReply({
      content: `✅ CSS from \`${link}\` — ${stylesheetHrefs.length} stylesheet(s), ${inlineStyles.length} inline style(s) (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_styles.txt` })],
    });

    logger.info({ url: link, external: stylesheetHrefs.length, inline: inlineStyles.length }, "/css success");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── /assets ─────────────────────────────────────────────────────────────────

interface AssetMap {
  images: string[];
  videos: string[];
  audio: string[];
  fonts: string[];
  icons: string[];
  other: string[];
}

function extractAssets(html: string, baseUrl: URL): AssetMap {
  const assets: AssetMap = { images: [], videos: [], audio: [], fonts: [], icons: [], other: [] };

  function resolveUrl(raw: string): string | null {
    try { return new URL(raw, baseUrl).href; } catch { return null; }
  }

  function classify(urlStr: string): keyof AssetMap {
    const lower = urlStr.toLowerCase().split("?")[0];
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)(\b|$)/.test(lower)) return "images";
    if (/\.(mp4|webm|ogv|mov|avi|mkv)(\b|$)/.test(lower)) return "videos";
    if (/\.(mp3|ogg|wav|flac|aac|m4a)(\b|$)/.test(lower)) return "audio";
    if (/\.(woff2?|ttf|otf|eot)(\b|$)/.test(lower)) return "fonts";
    if (/favicon|\.ico(\b|$)/.test(lower)) return "icons";
    return "other";
  }

  function add(raw: string | null | undefined): void {
    if (!raw || raw.startsWith("data:")) return;
    const resolved = resolveUrl(raw.trim());
    if (!resolved) return;
    const cat = classify(resolved);
    if (!assets[cat].includes(resolved)) assets[cat].push(resolved);
  }

  // <img src>
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  // <img srcset>
  for (const m of html.matchAll(/<img[^>]+srcset=["']([^"']+)["']/gi)) {
    for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0]);
  }
  // <source src / srcset>
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<source[^>]+srcset=["']([^"']+)["']/gi)) {
    for (const part of m[1].split(",")) add(part.trim().split(/\s+/)[0]);
  }
  // <video src>
  for (const m of html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  // <audio src>
  for (const m of html.matchAll(/<audio[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  // <link rel="icon" / rel="preload" as="font" / rel="preload" as="image">
  for (const m of html.matchAll(/<link[^>]+>/gi)) {
    const tag = m[0];
    const hrefM = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || "";
    const as_ = (tag.match(/\bas=["']([^"']+)["']/i) || [])[1] || "";
    if (/icon|apple-touch-icon/.test(rel)) { add(hrefM[1]); }
    else if (rel === "preload" && (as_ === "font" || as_ === "image")) { add(hrefM[1]); }
  }
  // CSS url() in inline styles
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(m[1]);

  return assets;
}

async function handleAssets(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
    return;
  }

  try {
    await interaction.editReply("⏳ Scanning page for assets...");

    const html = await fetchText(link);
    const assets = extractAssets(html, url);

    const total = Object.values(assets).reduce((a, b) => a + b.length, 0);
    if (total === 0) {
      await interaction.editReply("ℹ️ No assets found on this page.");
      return;
    }

    const sep = "═".repeat(80);
    const div = "─".repeat(80);
    const lines: string[] = [
      sep,
      `ASSET SCAN — ${link}`,
      `Generated: ${new Date().toISOString()}`,
      `Total assets found: ${total}`,
      `  Images: ${assets.images.length}  |  Videos: ${assets.videos.length}  |  Audio: ${assets.audio.length}`,
      `  Fonts:  ${assets.fonts.length}   |  Icons:  ${assets.icons.length}   |  Other: ${assets.other.length}`,
      sep, "",
    ];

    const sections: [keyof AssetMap, string][] = [
      ["images", "IMAGES"],
      ["videos", "VIDEOS"],
      ["audio",  "AUDIO"],
      ["fonts",  "FONTS"],
      ["icons",  "ICONS"],
      ["other",  "OTHER"],
    ];

    for (const [key, label] of sections) {
      if (assets[key].length === 0) continue;
      lines.push(div, `${label} (${assets[key].length})`, div, "");
      assets[key].forEach((u, i) => lines.push(`${i + 1}. ${u}`));
      lines.push("");
    }

    const buffer = Buffer.from(lines.join("\n"), "utf-8");
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");

    await interaction.editReply({
      content: `✅ Assets from \`${link}\` — ${total} total (${assets.images.length} images, ${assets.fonts.length} fonts, ${assets.videos.length} videos, ${assets.audio.length} audio, ${assets.icons.length} icons, ${assets.other.length} other)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_assets.txt` })],
    });

    logger.info({ url: link, total }, "/assets success");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── /full ───────────────────────────────────────────────────────────────────

async function buildHtmlBuffer(html: string): Promise<Buffer> {
  return Buffer.from(html, "utf-8");
}

async function buildJsBuffer(html: string, baseUrl: URL): Promise<Buffer> {
  const scriptSrcs = extractScriptSrcs(html, baseUrl);
  const inlineScripts = extractInlineScripts(html);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines: string[] = [
    sep, `JS EXTRACTION — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`,
    `External JS files: ${scriptSrcs.length}`, `Inline scripts: ${inlineScripts.length}`, sep, "",
  ];
  if (inlineScripts.length > 0) {
    lines.push(div, `INLINE SCRIPTS (${inlineScripts.length})`, div, "");
    inlineScripts.forEach((s, i) => lines.push(`// ── Inline #${i + 1} ──`, s, ""));
  }
  if (scriptSrcs.length > 0) {
    lines.push(div, `EXTERNAL JS FILES (${scriptSrcs.length})`, div, "");
    for (let i = 0; i < scriptSrcs.length; i++) {
      lines.push(`// ── File #${i + 1}: ${scriptSrcs[i]} ──`);
      try { lines.push(await fetchText(scriptSrcs[i], 10000), ""); }
      catch (err) { lines.push(`// ⚠ Could not load: ${axiosErrorMessage(err)}`, ""); }
    }
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

async function buildCssBuffer(html: string, baseUrl: URL): Promise<Buffer> {
  const hrefs = extractStylesheetHrefs(html, baseUrl);
  const inline = extractInlineStyles(html);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines: string[] = [
    sep, `CSS EXTRACTION — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`,
    `External stylesheets: ${hrefs.length}`, `Inline styles: ${inline.length}`, sep, "",
  ];
  if (inline.length > 0) {
    lines.push(div, `INLINE STYLES (${inline.length})`, div, "");
    inline.forEach((s, i) => lines.push(`/* ── Inline #${i + 1} ── */`, s, ""));
  }
  if (hrefs.length > 0) {
    lines.push(div, `EXTERNAL STYLESHEETS (${hrefs.length})`, div, "");
    for (let i = 0; i < hrefs.length; i++) {
      lines.push(`/* ── File #${i + 1}: ${hrefs[i]} ── */`);
      try { lines.push(await fetchText(hrefs[i], 10000), ""); }
      catch (err) { lines.push(`/* ⚠ Could not load: ${axiosErrorMessage(err)} */`, ""); }
    }
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

function buildAssetsBuffer(html: string, baseUrl: URL): Buffer {
  const assets = extractAssets(html, baseUrl);
  const total = Object.values(assets).reduce((a, b) => a + b.length, 0);
  const sep = "═".repeat(80), div = "─".repeat(80);
  const lines: string[] = [
    sep, `ASSET SCAN — ${baseUrl.href}`, `Generated: ${new Date().toISOString()}`, `Total assets: ${total}`,
    `  Images: ${assets.images.length}  Videos: ${assets.videos.length}  Audio: ${assets.audio.length}`,
    `  Fonts:  ${assets.fonts.length}   Icons:  ${assets.icons.length}   Other: ${assets.other.length}`,
    sep, "",
  ];
  const sections: [keyof AssetMap, string][] = [
    ["images","IMAGES"],["videos","VIDEOS"],["audio","AUDIO"],["fonts","FONTS"],["icons","ICONS"],["other","OTHER"],
  ];
  for (const [key, label] of sections) {
    if (assets[key].length === 0) continue;
    lines.push(div, `${label} (${assets[key].length})`, div, "");
    assets[key].forEach((u, i) => lines.push(`${i + 1}. ${u}`));
    lines.push("");
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

async function handleFull(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Invalid URL. Example: `https://example.com`");
    return;
  }

  try {
    await interaction.editReply("⏳ Fetching page — extracting HTML, JS, CSS and assets...");

    const html = await fetchText(link);
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");

    const [htmlBuf, jsBuf, cssBuf] = await Promise.all([
      buildHtmlBuffer(html),
      buildJsBuffer(html, url),
      buildCssBuffer(html, url),
    ]);
    const assetsBuf = buildAssetsBuffer(html, url);

    const files: AttachmentBuilder[] = [];
    const notes: string[] = [];
    const limit = 8 * 1024 * 1024;

    if (htmlBuf.byteLength <= limit)   files.push(new AttachmentBuilder(htmlBuf,   { name: `${hostname}_source.txt` }));
    else notes.push("HTML too large");
    if (jsBuf.byteLength <= limit)     files.push(new AttachmentBuilder(jsBuf,     { name: `${hostname}_scripts.txt` }));
    else notes.push("JS too large");
    if (cssBuf.byteLength <= limit)    files.push(new AttachmentBuilder(cssBuf,    { name: `${hostname}_styles.txt` }));
    else notes.push("CSS too large");
    if (assetsBuf.byteLength <= limit) files.push(new AttachmentBuilder(assetsBuf, { name: `${hostname}_assets.txt` }));
    else notes.push("Assets too large");

    const warning = notes.length > 0 ? ` ⚠️ Skipped (too large): ${notes.join(", ")}.` : "";

    await interaction.editReply({
      content: `✅ Full extraction of \`${link}\` — ${files.length}/4 files attached.${warning}`,
      files,
    });

    logger.info({ url: link, files: files.length }, "/full success");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── Start bot ───────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot logged in");
    await registerCommands(c.user.id);
    const permissions = 1024 + 2048 + 32768;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${c.user.id}&permissions=${permissions}&scope=bot%20applications.commands`;
    logger.info({ inviteUrl }, "Bot invite link");
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "hmtl")   await handleHmtl(interaction);
    if (interaction.commandName === "java")   await handleJava(interaction);
    if (interaction.commandName === "css")    await handleCss(interaction);
    if (interaction.commandName === "assets") await handleAssets(interaction);
    if (interaction.commandName === "full")   await handleFull(interaction);
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}
