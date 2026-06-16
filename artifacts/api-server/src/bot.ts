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
    .setName("whale")
    .setDescription("Gibt die komplette HTML-Quelle einer URL als .txt zurück")
    .addStringOption((o) =>
      o.setName("link").setDescription("Die URL").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("all")
    .setDescription("Extrahiert alle JavaScript-Dateien & Inline-Scripts einer URL (nur für eigene/educational Sites)")
    .addStringOption((o) =>
      o.setName("link").setDescription("Die URL").setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token!);
  logger.info("Registriere Slash-Commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Slash-Commands erfolgreich registriert.");
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

// ─── /whale ──────────────────────────────────────────────────────────────────

async function handleWhale(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Ungültige URL. Beispiel: `https://example.com`");
    return;
  }

  try {
    const html = await fetchText(link);
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const buffer = Buffer.from(html, "utf-8");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      await interaction.editReply("❌ Seite zu groß (max. 8 MB).");
      return;
    }

    await interaction.editReply({
      content: `✅ HTML-Quelle von \`${link}\` (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_source.txt` })],
    });
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── /all ────────────────────────────────────────────────────────────────────

function extractScriptSrcs(html: string, baseUrl: URL): string[] {
  const srcs: string[] = [];
  const srcRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = srcRegex.exec(html)) !== null) {
    const src = match[1];
    try {
      const absolute = new URL(src, baseUrl).href;
      srcs.push(absolute);
    } catch {
      // ungültige URL überspringen
    }
  }
  return srcs;
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const inlineRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = inlineRegex.exec(html)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) {
      scripts.push(content);
    }
  }
  return scripts;
}

async function handleAll(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);
  await interaction.deferReply();

  const url = validateUrl(link);
  if (!url) {
    await interaction.editReply("❌ Ungültige URL. Beispiel: `https://example.com`");
    return;
  }

  try {
    await interaction.editReply("⏳ Lade Seite und extrahiere JavaScript...");

    const html = await fetchText(link);
    const scriptSrcs = extractScriptSrcs(html, url);
    const inlineScripts = extractInlineScripts(html);

    const sections: string[] = [];
    const sep = "═".repeat(80);

    sections.push(
      `${sep}`,
      `JS-EXTRAKTION — ${link}`,
      `Erstellt: ${new Date().toISOString()}`,
      `Externe JS-Dateien gefunden: ${scriptSrcs.length}`,
      `Inline-Scripts gefunden:     ${inlineScripts.length}`,
      sep,
      ""
    );

    // Inline Scripts
    if (inlineScripts.length > 0) {
      sections.push(`${"─".repeat(80)}`, `INLINE SCRIPTS (${inlineScripts.length})`, `${"─".repeat(80)}`, "");
      inlineScripts.forEach((script, i) => {
        sections.push(`// ── Inline Script #${i + 1} ──`, script, "");
      });
    }

    // Externe JS-Dateien
    if (scriptSrcs.length > 0) {
      sections.push(`${"─".repeat(80)}`, `EXTERNE JS-DATEIEN (${scriptSrcs.length})`, `${"─".repeat(80)}`, "");

      for (let i = 0; i < scriptSrcs.length; i++) {
        const src = scriptSrcs[i];
        sections.push(`// ── Datei #${i + 1}: ${src} ──`);
        try {
          const jsContent = await fetchText(src, 10000);
          sections.push(jsContent, "");
        } catch (err) {
          sections.push(`// ⚠ Konnte nicht geladen werden: ${axiosErrorMessage(err)}`, "");
        }
      }
    }

    if (inlineScripts.length === 0 && scriptSrcs.length === 0) {
      await interaction.editReply("ℹ️ Keine JavaScript-Scripts auf dieser Seite gefunden.");
      return;
    }

    const combined = sections.join("\n");
    const buffer = Buffer.from(combined, "utf-8");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      // Zu groß: nur Inline-Scripts + Script-URLs (ohne Inhalt)
      const fallback = [
        `JS-EXTRAKTION (gekürzt) — ${link}`,
        `Datei zu groß für Discord. Hier nur die Script-URLs:`,
        "",
        ...scriptSrcs.map((s, i) => `${i + 1}. ${s}`),
        "",
        `Inline Scripts (${inlineScripts.length}):`,
        ...inlineScripts.map((s, i) => `\n// Script #${i + 1}\n${s}`),
      ].join("\n");

      const fallbackBuf = Buffer.from(fallback, "utf-8");
      const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
      await interaction.editReply({
        content: `⚠️ Vollinhalt zu groß – hier die Script-URLs und Inline-Scripts von \`${link}\``,
        files: [new AttachmentBuilder(fallbackBuf, { name: `${hostname}_scripts_urls.txt` })],
      });
      return;
    }

    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    await interaction.editReply({
      content: `✅ JavaScript von \`${link}\` — ${scriptSrcs.length} externe Datei(en), ${inlineScripts.length} Inline-Script(s) (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [new AttachmentBuilder(buffer, { name: `${hostname}_scripts.txt` })],
    });

    logger.info({ url: link, external: scriptSrcs.length, inline: inlineScripts.length }, "/all erfolgreich");
  } catch (err) {
    await interaction.editReply(axiosErrorMessage(err));
  }
}

// ─── Hilfsfunktion ───────────────────────────────────────────────────────────

function axiosErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === "ECONNABORTED") return "❌ Timeout – Seite hat nicht rechtzeitig geantwortet.";
    if (err.response) return `❌ HTTP-Fehler \`${err.response.status}\` beim Abrufen der URL.`;
    return `❌ Verbindungsfehler: \`${err.message}\``;
  }
  return "❌ Unbekannter Fehler.";
}

// ─── Bot starten ─────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async (c) => {
    logger.info({ tag: c.user.tag }, "Discord Bot eingeloggt");
    await registerCommands(c.user.id);
    const permissions = 1024 + 2048 + 32768;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${c.user.id}&permissions=${permissions}&scope=bot%20applications.commands`;
    logger.info({ inviteUrl }, "Bot Invite-Link");
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "whale") await handleWhale(interaction);
    if (interaction.commandName === "all") await handleAll(interaction);
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord Client Fehler");
  });

  await client.login(token);
}
