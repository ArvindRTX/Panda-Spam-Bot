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
        username VARCHAR(100),
        added_by VARCHAR(30),
        added_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await pool.query('ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS username VARCHAR(100)');
      await pool.query('ALTER TABLE authorized_users ALTER COLUMN added_at TYPE TIMESTAMPTZ USING added_at AT TIME ZONE \'UTC\'');
    } catch (alterErr) {
      console.warn('[Database] Alter authorized_users warning:', alterErr.message);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spam_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(30) NOT NULL,
        username VARCHAR(100),
        guild_id VARCHAR(30),
        channel_id VARCHAR(30),
        message_text VARCHAR(200),
        click_count INTEGER DEFAULT 1,
        initiated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await pool.query('ALTER TABLE spam_logs ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 1');
      await pool.query('ALTER TABLE spam_logs ALTER COLUMN initiated_at TYPE TIMESTAMPTZ USING initiated_at AT TIME ZONE \'UTC\'');
    } catch (alterErr) {
      console.warn('[Database] Alter spam_logs warning:', alterErr.message);
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spam_sessions (
        session_id VARCHAR(50) PRIMARY KEY,
        message_text TEXT NOT NULL,
        spam_count INTEGER DEFAULT 5,
        delay_ms INTEGER DEFAULT 100,
        use_tts BOOLEAN DEFAULT FALSE,
        use_embed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await pool.query('ALTER TABLE spam_sessions ALTER COLUMN delay_ms SET DEFAULT 100');
      await pool.query('ALTER TABLE spam_sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE \'UTC\'');
    } catch (alterErr) {
      console.warn('[Database] Alter spam_sessions warning:', alterErr.message);
    }
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

// Start an Express HTTP server with dashboard routing and JSON parsing
const app = express();
const port = process.env.PORT || 3000;
const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

app.use(express.json());
app.use(express.static('public'));

// Password authorization middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token === adminPassword) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Authentication verification endpoint
app.post('/api/verify-auth', (req, res) => {
  const { password } = req.body;
  if (password === adminPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// System Status endpoint
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const discordLatency = client.ws.ping;
    const guildCount = client.guilds.cache.size;
    
    let totalLogs = 0;
    let authorizedCount = authorizedUsers.length;

    if (databaseUrl) {
      const logsRes = await pool.query('SELECT COUNT(*) FROM spam_logs');
      totalLogs = parseInt(logsRes.rows[0].count, 10);

      const usersRes = await pool.query('SELECT COUNT(*) FROM authorized_users');
      authorizedCount = parseInt(usersRes.rows[0].count, 10);
    }

    res.json({
      status: client.isReady() ? 'Online' : 'Offline',
      uptime: Math.round(process.uptime()),
      latency: discordLatency >= 0 ? discordLatency : 0,
      guilds: guildCount,
      totalLogs,
      authorizedCount,
      ownerId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authorized Users retrieval endpoint
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    let users = [];
    let source = 'env';

    if (databaseUrl) {
      const usersRes = await pool.query('SELECT user_id, username, added_by, added_at FROM authorized_users ORDER BY added_at DESC');
      users = usersRes.rows;
      source = 'database';
    } else {
      users = authorizedUsers.map(id => ({
        user_id: id,
        username: null,
        added_by: 'Environment Fallback',
        added_at: new Date()
      }));
    }

    // Self-healing: Resolve missing usernames dynamically via Discord Client
    for (let user of users) {
      if (!user.username) {
        try {
          const discordUser = await client.users.fetch(user.user_id);
          user.username = discordUser.tag || discordUser.username;
          
          if (source === 'database') {
            pool.query('UPDATE authorized_users SET username = $1 WHERE user_id = $2', [user.username, user.user_id]).catch(dbErr => {
              console.error(`[Database] Failed to backfill username for ${user.user_id}:`, dbErr.message);
            });
          }
        } catch (fetchErr) {
          console.warn(`[API] Could not resolve username for user ID ${user.user_id}:`, fetchErr.message);
        }
      }
    }

    res.json({ users, source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authorize User endpoint
app.post('/api/users/authorize', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid User ID format (must be 17-20 digits)' });
  }

  try {
    if (!databaseUrl) {
      return res.status(400).json({ error: 'Database is not configured. Cannot add authorized users dynamically.' });
    }

    let username = 'Unknown';
    try {
      const user = await client.users.fetch(userId);
      username = user.tag || user.username;
    } catch (fetchErr) {
      console.warn(`[Web Dashboard] Could not fetch username for ID ${userId}:`, fetchErr.message);
    }

    await pool.query(
      'INSERT INTO authorized_users (user_id, username, added_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username',
      [userId, username, 'Web Dashboard']
    );
    res.json({ success: true, message: `Successfully authorized user ${username} (${userId})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deauthorize User endpoint
app.post('/api/users/deauthorize', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Invalid User ID' });
  }

  if (userId === ownerId) {
    return res.status(400).json({ error: 'Cannot deauthorize the application owner.' });
  }

  try {
    if (!databaseUrl) {
      return res.status(400).json({ error: 'Database is not configured. Cannot remove authorized users dynamically.' });
    }

    const result = await pool.query('DELETE FROM authorized_users WHERE user_id = $1', [userId]);
    if (result.rowCount > 0) {
      res.json({ success: true, message: `Successfully deauthorized user ${userId}` });
    } else {
      res.status(404).json({ error: 'User was not authorized.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Spam Logs retrieval endpoint
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    if (databaseUrl) {
      const logsRes = await pool.query(
        'SELECT user_id, username, guild_id, channel_id, message_text, click_count, initiated_at FROM spam_logs ORDER BY initiated_at DESC LIMIT 50'
      );
      res.json({ logs: logsRes.rows });
    } else {
      res.json({ logs: [], message: 'Database is not configured. Logs are unavailable.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
const localSpamSessions = new Map();

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
        const sendOptions = {
          tts: item.tts || false
        };

        if (item.embed) {
          sendOptions.embeds = [{
            color: 0x5865F2, // Blurple
            description: item.messageText,
            timestamp: new Date().toISOString(),
            footer: {
              text: 'Panda Spammer Pro 🐼'
            }
          }];
        } else {
          sendOptions.content = item.messageText;
        }

        const msg = await item.interaction.followUp(sendOptions);
        userData.messages.push({
          id: msg.id,
          channelId: msg.channelId,
          webhook: item.interaction.webhook
        });
        console.log(`[Spam] Sent message ${msg.id} for user ${userId}`);
      } catch (loopError) {
        console.error(`[Spam Queue Error] Failed to send follow-up message for user ${userId}:`, loopError.message);
      }

      // Add a custom delay between messages to preserve order and avoid rate limits
      if (userData.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, item.delay || 100));
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
        const count = 5; // Fixed to 5x spam
        const delay = interaction.options.getInteger('delay') ?? 100;
        const tts = interaction.options.getBoolean('tts') ?? false;
        const embed = interaction.options.getBoolean('embed') ?? false;

        const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

        if (databaseUrl) {
          await pool.query(
            'INSERT INTO spam_sessions (session_id, message_text, spam_count, delay_ms, use_tts, use_embed) VALUES ($1, $2, $3, $4, $5, $6)',
            [sessionId, message, count, delay, tts, embed]
          );
        } else {
          localSpamSessions.set(sessionId, {
            message_text: message,
            spam_count: count,
            delay_ms: delay,
            use_tts: tts,
            use_embed: embed
          });
        }

        const buttonLabel = `Spam 5x` + (embed ? ' (Embed)' : '') + (tts ? ' (TTS)' : '');
        const button = new ButtonBuilder()
          .setCustomId(`spam_click:${sessionId}`)
          .setLabel(buttonLabel)
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
          content: `⚙️ **Spam Configured:**\n* **Quantity:** 5 messages (Fixed)\n* **Delay:** ${delay}ms\n* **TTS:** ${tts ? 'Enabled' : 'Disabled'}\n* **Format:** ${embed ? 'Rich Embed' : 'Plain Text'}\n\nClick the button below to initiate.`,
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error executing /spam command:', error);
        await interaction.reply({
          content: '❌ An error occurred while setting up the spam session.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
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
            const dateStr = row.added_at ? new Date(row.added_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'N/A';
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
          'SELECT user_id, username, guild_id, channel_id, message_text, click_count, initiated_at FROM spam_logs ORDER BY initiated_at DESC LIMIT 15'
        );

        if (res.rowCount > 0) {
          const logsList = res.rows.map((row) => {
            const dateStr = row.initiated_at ? new Date(row.initiated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'N/A';
            const server = row.guild_id ? `Server ID: \`${row.guild_id}\`` : 'DM';
            const channel = row.channel_id ? `<#${row.channel_id}> (\`${row.channel_id}\`)` : 'N/A';
            const clicks = row.click_count || 1;
            const cleanText = row.message_text.replace(/`/g, '\\`').slice(0, 100);
            return `📅 **${dateStr}** (Clicks: **${clicks}**)\n👤 **User:** <@${row.user_id}> (\`${row.username || row.user_id}\`)\n🌐 **Location:** ${server} | **Channel:** ${channel}\n💬 **Message:** \`${cleanText}\`\n`;
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

    else if (commandName === 'stopall') {
      try {
        const executorId = interaction.user.id;

        // Owner only check
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can use this command.',
            flags: MessageFlags.Ephemeral
          });
        }

        let stopCount = 0;
        userSpams.forEach((userData) => {
          if (userData.queue.length > 0 || userData.sending) {
            userData.queue = [];
            stopCount++;
          }
        });

        await interaction.reply({
          content: `🛑 Stopped active spam sequences for **${stopCount}** users.`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error executing /stopall command:', error);
        await interaction.reply({
          content: '❌ An error occurred while stopping all spams.',
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
    }

    else if (commandName === 'unsendall') {
      try {
        const executorId = interaction.user.id;

        // Owner only check
        if (!ownerId || executorId !== ownerId) {
          return interaction.reply({
            content: '❌ Only the application owner can use this command.',
            flags: MessageFlags.Ephemeral
          });
        }

        // First stop all active queues
        userSpams.forEach((userData) => {
          userData.queue = [];
        });

        // Wait for any active sends to finish
        let anySending = true;
        let checks = 0;
        while (anySending && checks < 20) {
          anySending = false;
          userSpams.forEach((userData) => {
            if (userData.sending) anySending = true;
          });
          if (anySending) {
            await new Promise(resolve => setTimeout(resolve, 50));
            checks++;
          }
        }

        // Gather all messages to delete
        const allMessages = [];
        userSpams.forEach((userData) => {
          if (userData.messages.length > 0) {
            allMessages.push(...userData.messages);
            userData.messages = []; // Clear local list immediately
          }
        });

        if (allMessages.length > 0) {
          await interaction.reply({
            content: `🧹 Deleting **${allMessages.length}** messages sent by all users to clean traces...`,
            flags: MessageFlags.Ephemeral
          });

          const deletePromises = allMessages.map(async (item) => {
            try {
              // Try webhook deletion first
              await item.webhook.deleteMessage(item.id);
              return true;
            } catch (webhookError) {
              try {
                // Fallback to bot token API channel fetch
                const channel = await client.channels.fetch(item.channelId);
                const fetchedMsg = await channel.messages.fetch(item.id);
                await fetchedMsg.delete();
                return true;
              } catch (deleteError) {
                console.error(`[Unsendall Error] Failed to delete message ${item.id}:`, deleteError.message);
                return false;
              }
            }
          });

          const results = await Promise.all(deletePromises);
          const deletedCount = results.filter(Boolean).length;

          await interaction.followUp({
            content: `✨ Successfully deleted **${deletedCount}** of **${allMessages.length}** total tracked messages.`,
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content: 'No spam messages found to delete.',
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) {
        console.error('Error executing /unsendall command:', error);
        await interaction.reply({
          content: '❌ An error occurred while unsending all messages.',
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
        const sessionId = customId.slice('spam_click:'.length);
        const userId = interaction.user.id;

        // Fetch spam options from either database or local Map
        let session = null;
        if (databaseUrl) {
          try {
            const res = await pool.query(
              'SELECT message_text, spam_count, delay_ms, use_tts, use_embed FROM spam_sessions WHERE session_id = $1',
              [sessionId]
            );
            if (res.rowCount > 0) {
              session = res.rows[0];
            }
          } catch (dbErr) {
            console.error('[Database] Failed to fetch spam session:', dbErr.message);
          }
        }

        if (!session) {
          session = localSpamSessions.get(sessionId);
        }

        if (!session) {
          try {
            await interaction.followUp({
              content: '❌ This spam session has expired or is invalid.',
              flags: MessageFlags.Ephemeral
            }).catch(() => {});
          } catch (err) {}
          return;
        }

        const messageText = session.message_text;
        const count = session.spam_count || 5;
        const delay = session.delay_ms || 100;
        const tts = session.use_tts || false;
        const embed = session.use_embed || false;

        // Initialize user entry if not exists
        if (!userSpams.has(userId)) {
          userSpams.set(userId, { queue: [], sending: false, messages: [] });
        }
        const userData = userSpams.get(userId);

        // Acknowledge the interaction immediately to prevent timeout silently
        await interaction.deferUpdate();

        // Log the spam initiation if database is configured (avoiding duplicates within 3 minutes)
        if (databaseUrl) {
          try {
            // Check if there is an existing log for this user, channel, and message text in the last 3 minutes
            const checkLog = await pool.query(
              `SELECT id FROM spam_logs 
               WHERE user_id = $1 AND channel_id = $2 AND message_text = $3 
               AND initiated_at > NOW() - INTERVAL '3 minutes'
               ORDER BY initiated_at DESC LIMIT 1`,
              [userId, interaction.channelId || null, messageText.slice(0, 200)]
            );

            if (checkLog.rowCount > 0) {
              // Duplicate found! Increment click count instead of inserting new row
              const logId = checkLog.rows[0].id;
              await pool.query(
                'UPDATE spam_logs SET click_count = click_count + 1, initiated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [logId]
              );
            } else {
              // No recent duplicate. Insert fresh record.
              await pool.query(
                'INSERT INTO spam_logs (user_id, username, guild_id, channel_id, message_text, click_count) VALUES ($1, $2, $3, $4, $5, 1)',
                [
                  userId,
                  interaction.user.tag || interaction.user.username,
                  interaction.guildId || null,
                  interaction.channelId || null,
                  messageText.slice(0, 200)
                ]
              );
            }
          } catch (dbErr) {
            console.error('[Database] Failed to log spam execution:', dbErr.message);
          }
        }

        // Add customizable messages to the queue
        for (let i = 0; i < count; i++) {
          userData.queue.push({
            messageText,
            interaction,
            tts,
            embed,
            delay
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
