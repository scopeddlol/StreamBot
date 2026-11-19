import { Client } from "discord.js-selfbot-v13";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import logger from './utils/logger.js';
import { downloadExecutable, checkForUpdatesAndUpdate } from './utils/yt-dlp.js';

// Import event handlers
import { handleReady } from './events/client/ready.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate.js';

// Import services
import { StreamingService } from './services/streaming.js';
import { CommandManager } from './commands/manager.js';
import { QueueService } from './services/queue.js';

// Validate before any authenticated connection; values are never logged.
if (!config.token || !config.guildId || !config.videoChannelId || !config.cmdChannelId || !config.prefix || !config.adminIds.length) {
  throw new Error('Configure TOKEN, PREFIX, GUILD_ID, VIDEO_CHANNEL_ID, COMMAND_CHANNEL_ID and ADMIN_IDS');
}

// Download yt-dlp and check for updates
(async () => {
	try {
		await downloadExecutable();
		if (process.env.YTDLP_AUTO_UPDATE === 'true') await checkForUpdatesAndUpdate();
	} catch (error) {
		logger.error("Error during initial yt-dlp setup/update:", error);
	}
})();

// Create a new instance of Client
const client = new Client();

// Stream status object
const queueService = new QueueService();
const streamStatus = {
	joined: false,
	joinsucc: false,
	playing: false,
	manualStop: false,
	channelInfo: {
		guildId: config.guildId,
		channelId: config.videoChannelId,
		cmdChannelId: config.cmdChannelId
	},
	queue: queueService.getQueueStatus()
}

// Create services
const streamingService = new StreamingService(client, streamStatus);
const commandManager = new CommandManager();

// Create the videosFolder dir if it doesn't exist
if (!fs.existsSync(config.videosDir)) {
	fs.mkdirSync(config.videosDir);
}

// Create previewCache parent dir if it doesn't exist
if (!fs.existsSync(path.dirname(config.previewCacheDir))) {
	fs.mkdirSync(path.dirname(config.previewCacheDir), { recursive: true });
}

// Create the previewCache dir if it doesn't exist
if (!fs.existsSync(config.previewCacheDir)) {
	fs.mkdirSync(config.previewCacheDir);
}

// Get all video files
const videoFiles = fs.readdirSync(config.videosDir);

// Create an array of video objects
let videos = videoFiles.map(file => {
	const fileName = path.parse(file).name;
	return { name: fileName, path: path.join(config.videosDir, file) };
});

// Event handlers
client.on("ready", async () => {
	await handleReady(client);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
	await handleVoiceStateUpdate(oldState, newState, streamStatus, client);
});

client.on('messageCreate', async (message) => {
	await handleMessageCreate(message, videos, streamStatus, streamingService, commandManager);
});

// Run server if enabled in config
if (config.server_enabled) {
	// Run server.ts
	const { startServer } = await import('./server/index.js');
	const server = startServer(streamingService.providers, streamingService);
	process.on('SIGTERM', () => server.close());
	process.on('SIGINT', () => server.close());
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 25000); deadline.unref();
  await streamingService.stopAndClearQueue();
  client.destroy();
  clearTimeout(deadline);
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
client.login(config.token).catch(() => { logger.error('Discord login failed; check TOKEN privately'); process.exit(1); });