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

const commands = [
  new SlashCommandBuilder()
    .setName("whale")
    .setDescription("Öffnet eine URL und gibt die HTML-Quelle als .txt-Datei zurück")
    .addStringOption((option) =>
      option
        .setName("link")
        .setDescription("Die URL, deren Seitenquelle abgerufen werden soll")
        .setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands(clientId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token!);
  logger.info("Registriere Slash-Commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("Slash-Commands erfolgreich registriert.");
}

async function handleWhale(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = interaction.options.getString("link", true);

  await interaction.deferReply();

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    await interaction.editReply("❌ Ungültige URL. Bitte gib eine vollständige URL ein (z.B. `https://example.com`).");
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    await interaction.editReply("❌ Nur HTTP- und HTTPS-URLs sind erlaubt.");
    return;
  }

  try {
    logger.info({ url: link }, "Rufe URL ab");

    const response = await axios.get<string>(link, {
      responseType: "text",
      timeout: 15000,
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const html = response.data;
    const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const filename = `${hostname}_source.txt`;

    const buffer = Buffer.from(html, "utf-8");

    if (buffer.byteLength > 8 * 1024 * 1024) {
      await interaction.editReply("❌ Die Seite ist zu groß (max. 8 MB).");
      return;
    }

    const attachment = new AttachmentBuilder(buffer, { name: filename });

    await interaction.editReply({
      content: `✅ Seitenquelle von \`${link}\` (${(buffer.byteLength / 1024).toFixed(1)} KB)`,
      files: [attachment],
    });

    logger.info({ url: link, size: buffer.byteLength }, "Seitenquelle erfolgreich gesendet");
  } catch (err) {
    logger.error({ err, url: link }, "Fehler beim Abrufen der URL");

    if (axios.isAxiosError(err)) {
      if (err.code === "ECONNABORTED") {
        await interaction.editReply("❌ Timeout – die Seite hat nicht rechtzeitig geantwortet.");
      } else if (err.response) {
        await interaction.editReply(
          `❌ HTTP-Fehler \`${err.response.status}\` beim Abrufen der URL.`
        );
      } else {
        await interaction.editReply(`❌ Verbindungsfehler: \`${err.message}\``);
      }
    } else {
      await interaction.editReply("❌ Unbekannter Fehler beim Abrufen der Seite.");
    }
  }
}

export async function startBot(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async (c) => {
    logger.info({ tag: c.user.tag }, "Discord Bot eingeloggt");
    await registerCommands(c.user.id);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "whale") {
      await handleWhale(interaction);
    }
  });

  client.on("error", (err) => {
    logger.error({ err }, "Discord Client Fehler");
  });

  await client.login(token);
}
