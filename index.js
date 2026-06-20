import { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Events,
  MessageFlags
} from 'discord.js';
import 'dotenv/config';
import express from 'express';

const token = process.env.DISCORD_TOKEN;

if (!token || token === 'your_bot_token_here') {
  console.error('Error: Please populate your DISCORD_TOKEN in the .env file before starting the bot.');
  process.exit(1);
}

// Start a dummy Express HTTP server to bind to a port for Render Free Web Service
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Panda AWM Bot is running!');
});

app.listen(port, () => {
  console.log(`Dummy HTTP server listening on port ${port}`);
});

// Create a new client instance
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Track active spam sessions and sent messages per user
const userSpams = new Map();

// Global REST rate limit listener to help monitor rate limits without crashing
client.rest.on('rateLimited', (info) => {
  console.warn(`[REST Rate Limit] Path: ${info.path} | Limit: ${info.limit} | TimeToReset: ${info.timeToReset}ms | Global: ${info.global}`);
});

client.once(Events.ClientReady, async () => {
  console.log(`Successfully logged in as ${client.user.tag}!`);
  console.log('Bot is ready to handle user-installable interactions.');

  try {
    console.log('Attempting to update profile picture using cute-dancing-panda.gif...');
    await client.user.setAvatar('./cute-dancing-panda.gif');
    console.log('Profile picture updated successfully!');
  } catch (error) {
    console.warn('Could not update profile picture (this is normal if rate limited by Discord):', error.message);
  }
});

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  // 1. Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'ping') {
      try {
        const message = interaction.options.getString('message');
        const button = new ButtonBuilder()
          .setCustomId(`ping_click:${message}`)
          .setLabel('Click Me')
          .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        // Reply with an ephemeral message containing the "Click Me" button
        await interaction.reply({
          content: 'Here is your button:',
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error executing /ping command:', error);
      }
    } 
    
    else if (commandName === 'spam') {
      try {
        const message = interaction.options.getString('message');
        const button = new ButtonBuilder()
          .setCustomId(`spam_click:${message}`)
          .setLabel('Click Me 5x')
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(button);

        // Reply with an ephemeral message containing the "Click Me 5x" button
        await interaction.reply({
          content: 'Here is your 5x spam button:',
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error executing /spam command:', error);
      }
    }

    else if (commandName === 'stop') {
      try {
        const userId = interaction.user.id;
        const userData = userSpams.get(userId);

        if (userData && userData.activeSessions.size > 0) {
          for (const session of userData.activeSessions) {
            session.active = false;
          }
          userData.activeSessions.clear();
          await interaction.reply({
            content: '🛑 Stopped all your active spam sequences.',
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: 'You do not have any active spam sequence running.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /stop command:', error);
      }
    }

    else if (commandName === 'unsend') {
      try {
        const userId = interaction.user.id;
        const userData = userSpams.get(userId);

        // First stop any active sessions for this user
        if (userData && userData.activeSessions.size > 0) {
          for (const session of userData.activeSessions) {
            session.active = false;
          }
          userData.activeSessions.clear();
        }

        if (userData && userData.messages.length > 0) {
          // Deleting messages
          const messagesToDelete = [...userData.messages];
          userData.messages = []; // Clear local list immediately to prevent double-deletes

          await interaction.reply({
            content: '🧹 Deleting spam messages to clean traces...',
            flags: MessageFlags.Ephemeral
          });

          let deletedCount = 0;
          for (const msg of messagesToDelete) {
            try {
              await msg.delete();
              deletedCount++;
            } catch (deleteError) {
              console.error('Failed to delete message:', deleteError.message);
            }
          }

          await interaction.followUp({
            content: `✨ Successfully deleted ${deletedCount} messages and cleared all traces.`,
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: 'No spam messages found to delete.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /unsend command:', error);
      }
    }
  }

  // 2. Handle Button Component Interactions
  else if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId.startsWith('ping_click:')) {
      try {
        const messageText = customId.slice('ping_click:'.length);
        // Triggered when "Click Me" button is clicked: replies with the custom message
        await interaction.reply({
          content: messageText
        });
      } catch (error) {
        console.error('Error handling ping_click button:', error);
      }
    } 
    
    else if (customId.startsWith('spam_click:')) {
      try {
        const messageText = customId.slice('spam_click:'.length);
        const userId = interaction.user.id;

        // Initialize user entry if not exists
        if (!userSpams.has(userId)) {
          userSpams.set(userId, { activeSessions: new Set(), messages: [] });
        }
        const userData = userSpams.get(userId);

        // Start a new session
        const session = { active: true };
        userData.activeSessions.add(session);

        // Acknowledge the interaction immediately to prevent timeout (ephemeral)
        await interaction.reply({
          content: 'Spam sequence initiated...'
        });

        // Loop to send exactly 5 separate follow-up messages
        for (let i = 1; i <= 5; i++) {
          if (!session.active) {
            break;
          }

          try {
            const msg = await interaction.followUp({
              content: messageText
            });
            userData.messages.push(msg);

            // Sleep 250ms between calls to speed up the spam sequence while keeping it safe
            await new Promise(resolve => setTimeout(resolve, 250));
          } catch (loopError) {
            console.error(`[Spam Loop Error] Failed to send follow-up ${i}/5:`, loopError.message);
            // Pause longer if we hit a rate limit, then continue. Bot won't crash.
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }

        userData.activeSessions.delete(session);
      } catch (error) {
        console.error('Error handling spam_click button:', error);
      }
    }
  }
});

// Catch unhandled promise rejections so the bot survives unexpected errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Login to Discord
client.login(token);
