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
import pg from 'pg';

const { Pool } = pg;
const token = process.env.DISCORD_TOKEN;
const databaseUrl = process.env.DATABASE_URL;
const ownerId = process.env.OWNER_ID;

const authorizedUsers = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(',').map(id => id.trim())
  : [];

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (!databaseUrl) {
    console.warn('[Database] WARNING: DATABASE_URL is not set. The bot will run without database integration.');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS authorized_users (
        user_id VARCHAR(30) PRIMARY KEY,
        added_by VARCHAR(30),
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spam_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(30) NOT NULL,
        username VARCHAR(100),
        guild_id VARCHAR(30),
        channel_id VARCHAR(30),
        message_text VARCHAR(200),
        initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[Database] PostgreSQL tables initialized successfully.');
  } catch (error) {
    console.error('[Database] Failed to initialize database:', error.message);
  }
}

async function isUserAuthorized(userId) {
  if (ownerId && userId === ownerId) {
    return true;
  }
  if (!databaseUrl) {
    return authorizedUsers.includes(userId);
  }
  try {
    const res = await pool.query('SELECT 1 FROM authorized_users WHERE user_id = $1', [userId]);
    return res.rowCount > 0;
  } catch (error) {
    console.error('[Database] Error checking authorization:', error.message);
    return authorizedUsers.includes(userId);
  }
}

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

// Track active spam queues and sent messages per user
const userSpams = new Map();

// Helper to process a user's spam queue sequentially
async function processQueue(userId) {
  const userData = userSpams.get(userId);
  if (!userData || userData.sending || userData.queue.length === 0) {
    return;
  }

  userData.sending = true;

  try {
    while (userData.queue.length > 0) {
      const item = userData.queue.shift();

      try {
        const msg = await item.interaction.followUp({
          content: item.messageText
        });
        userData.messages.push({
          id: msg.id,
          channelId: msg.channelId,
          webhook: item.interaction.webhook
        });
        console.log(`[Spam] Sent message ${msg.id} for user ${userId}`);
      } catch (loopError) {
        console.error(`[Spam Queue Error] Failed to send follow-up message for user ${userId}:`, loopError.message);
      }

      // Add a small delay between messages to preserve order and avoid rate limits
      if (userData.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  } finally {
    userData.sending = false;
  }
}

// Global REST rate limit listener to help monitor rate limits without crashing
client.rest.on('rateLimited', (info) => {
  console.warn(`[REST Rate Limit] Path: ${info.path} | Limit: ${info.limit} | TimeToReset: ${info.timeToReset}ms | Global: ${info.global}`);
});

client.once(Events.ClientReady, async () => {
  console.log(`Successfully logged in as ${client.user.tag}!`);
  console.log('Bot is ready to handle user-installable interactions.');

  // Initialize database
  await initDb();

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
  // Check authorization dynamically (checking owner, database, or fallback array)
  const isAuthorized = await isUserAuthorized(interaction.user.id);
  if (!isAuthorized) {
    try {
      await interaction.reply({
        content: `❌ You are Not Authorized to Use this App , DM Panda AWM <@${ownerId || '1322563623087767677'}> for access`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      console.error('Failed to reply to unauthorized user:', err.message);
    }
    return;
  }

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

        if (userData && (userData.queue.length > 0 || userData.sending)) {
          userData.queue = []; // Clear the queue to stop further sends immediately
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

        // First stop any active queue for this user
        if (userData) {
          userData.queue = [];
          // Wait for the active in-flight message to finish if sending is true
          while (userData.sending) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        if (userData && userData.messages.length > 0) {
          // Deleting messages
          const messagesToDelete = [...userData.messages];
          userData.messages = []; // Clear local list immediately to prevent double-deletes

          await interaction.reply({
            content: '🧹 Deleting spam messages to clean traces...',
            flags: MessageFlags.Ephemeral
          });

          const deletePromises = messagesToDelete.map(async (item) => {
            try {
              console.log(`[Unsend] Deleting message: ${item.id}`);
              // Try webhook deletion first (fast, works in user-installed non-member guild channels)
              await item.webhook.deleteMessage(item.id);
              return true;
            } catch (webhookError) {
              console.warn(`[Unsend Webhook Warning] Webhook deletion failed for message ${item.id}: ${webhookError.message}. Falling back to API channel fetch...`);
              try {
                // Fallback to fetching channel and message via bot token
                const channel = await client.channels.fetch(item.channelId);
                const fetchedMsg = await channel.messages.fetch(item.id);
                await fetchedMsg.delete();
                return true;
              } catch (deleteError) {
                console.error(`[Unsend Error] Failed to delete message ${item.id}:`, deleteError.message);
                return false;
              }
            }
          });

          const results = await Promise.all(deletePromises);
          const deletedCount = results.filter(Boolean).length;

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

    else if (commandName === 'authorize') {
      try {
        const targetUser = interaction.options.getUser('user');
        const executorId = interaction.user.id;

        // Strictly check that ONLY the owner can authorize users
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can authorize new users.',
            flags: MessageFlags.Ephemeral
          });
        }

        if (!databaseUrl) {
          return interaction.reply({
            content: '❌ Database is not configured. Cannot authorize users dynamically.',
            flags: MessageFlags.Ephemeral
          });
        }

        // Check if the user is already authorized
        const checkRes = await pool.query('SELECT 1 FROM authorized_users WHERE user_id = $1', [targetUser.id]);
        if (checkRes.rowCount > 0 || (ownerId && targetUser.id === ownerId)) {
          return interaction.reply({
            content: `ℹ️ User ${targetUser.username} (${targetUser.id}) is already authorized.`,
            flags: MessageFlags.Ephemeral
          });
        }

        await pool.query(
          'INSERT INTO authorized_users (user_id, added_by) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
          [targetUser.id, executorId]
        );

        await interaction.reply({
          content: `✅ Successfully authorized ${targetUser.username} (${targetUser.id}).`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error executing /authorize command:', error);
        await interaction.reply({
          content: '❌ Database error occurred while authorizing user.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }

    else if (commandName === 'deauthorize') {
      try {
        const targetUser = interaction.options.getUser('user');
        const executorId = interaction.user.id;

        // Strictly check that ONLY the owner can deauthorize users
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can deauthorize users.',
            flags: MessageFlags.Ephemeral
          });
        }

        if (targetUser.id === ownerId) {
          return interaction.reply({
            content: '❌ You cannot deauthorize the application owner.',
            flags: MessageFlags.Ephemeral
          });
        }

        if (!databaseUrl) {
          return interaction.reply({
            content: '❌ Database is not configured. Cannot deauthorize users dynamically.',
            flags: MessageFlags.Ephemeral
          });
        }

        const res = await pool.query('DELETE FROM authorized_users WHERE user_id = $1', [targetUser.id]);

        if (res.rowCount > 0) {
          await interaction.reply({
            content: `✅ Successfully removed authorization for ${targetUser.username} (${targetUser.id}).`,
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: `❓ User ${targetUser.username} (${targetUser.id}) was not authorized.`,
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /deauthorize command:', error);
        await interaction.reply({
          content: '❌ Database error occurred while deauthorizing user.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }

    else if (commandName === 'listauthorized') {
      try {
        const executorId = interaction.user.id;

        // Strictly check that ONLY the owner can run this
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can view the authorized users.',
            flags: MessageFlags.Ephemeral
          });
        }

        if (!databaseUrl) {
          // Fall back to environment variable list
          const fallbackList = authorizedUsers.length > 0 
            ? authorizedUsers.map(id => `<@${id}> (${id})`).join('\n') 
            : 'None';
          return interaction.reply({
            content: `ℹ️ Database not configured. Fallback authorized users from environment variable:\n**Owner:** <@${ownerId}>\n**Authorized Users:**\n${fallbackList}`,
            flags: MessageFlags.Ephemeral
          });
        }

        const res = await pool.query('SELECT user_id, added_by, added_at FROM authorized_users ORDER BY added_at DESC');

        if (res.rowCount > 0) {
          const userList = res.rows.map((row, idx) => {
            const dateStr = row.added_at ? new Date(row.added_at).toLocaleString() : 'N/A';
            return `${idx + 1}. <@${row.user_id}> (ID: ${row.user_id}) - Added by <@${row.added_by}> at ${dateStr}`;
          }).join('\n');

          await interaction.reply({
            content: `👑 **Authorized Users List** (Database):\n**Owner:** <@${ownerId}>\n\n${userList}`,
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: `👑 **Authorized Users List** (Database):\n**Owner:** <@${ownerId}>\n\nNo other users are currently authorized.`,
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /listauthorized command:', error);
        await interaction.reply({
          content: '❌ Database error occurred while listing authorized users.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }

    else if (commandName === 'spamlogs') {
      try {
        const executorId = interaction.user.id;

        // Strictly check that ONLY the owner can run this
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can view spam logs.',
            flags: MessageFlags.Ephemeral
          });
        }

        if (!databaseUrl) {
          return interaction.reply({
            content: '❌ Database is not configured. Cannot retrieve spam logs.',
            flags: MessageFlags.Ephemeral
          });
        }

        const res = await pool.query(
          'SELECT user_id, username, guild_id, channel_id, message_text, initiated_at FROM spam_logs ORDER BY initiated_at DESC LIMIT 15'
        );

        if (res.rowCount > 0) {
          const logsList = res.rows.map((row) => {
            const dateStr = row.initiated_at ? new Date(row.initiated_at).toLocaleString() : 'N/A';
            const server = row.guild_id ? `Server ID: \`${row.guild_id}\`` : 'DM';
            const channel = row.channel_id ? `<#${row.channel_id}> (\`${row.channel_id}\`)` : 'N/A';
            const cleanText = row.message_text.replace(/`/g, '\\`').slice(0, 100);
            return `📅 **${dateStr}**\n👤 **User:** <@${row.user_id}> (\`${row.username || row.user_id}\`)\n🌐 **Location:** ${server} | **Channel:** ${channel}\n💬 **Message:** \`${cleanText}\`\n`;
          }).join('\n');

          await interaction.reply({
            content: `📋 **Recent Spam Logs (Last 15):**\n\n${logsList}`,
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: 'ℹ️ No spam log entries found in the database.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /spamlogs command:', error);
        await interaction.reply({
          content: '❌ Database error occurred while retrieving spam logs.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
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
          userSpams.set(userId, { queue: [], sending: false, messages: [] });
        }
        const userData = userSpams.get(userId);

        // Acknowledge the interaction immediately to prevent timeout silently
        await interaction.deferUpdate();

        // Log the spam initiation if database is configured
        if (databaseUrl) {
          try {
            await pool.query(
              'INSERT INTO spam_logs (user_id, username, guild_id, channel_id, message_text) VALUES ($1, $2, $3, $4, $5)',
              [
                userId,
                interaction.user.tag || interaction.user.username,
                interaction.guildId || null,
                interaction.channelId || null,
                messageText.slice(0, 200)
              ]
            );
          } catch (dbErr) {
            console.error('[Database] Failed to log spam execution:', dbErr.message);
          }
        }

        // Add 5 messages to the queue
        for (let i = 0; i < 5; i++) {
          userData.queue.push({
            messageText,
            interaction
          });
        }

        // Start processing the queue (it will self-gate if already sending)
        processQueue(userId);
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
