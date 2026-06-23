import { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
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
      await pool.query('ALTER TABLE spam_logs ADD COLUMN IF NOT EXISTS guild_name VARCHAR(100)');
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
        self_destruct_seconds INTEGER DEFAULT 0,
        embed_title VARCHAR(200) NULL,
        embed_image_url VARCHAR(500) NULL,
        embed_color VARCHAR(10) NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await pool.query('ALTER TABLE spam_sessions ALTER COLUMN delay_ms SET DEFAULT 100');
      await pool.query('ALTER TABLE spam_sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE \'UTC\'');
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS self_destruct_seconds INTEGER DEFAULT 0');
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS embed_title VARCHAR(200) NULL');
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS embed_image_url VARCHAR(500) NULL');
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS embed_color VARCHAR(10) NULL');
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
    const status = await getSystemStatus();
    res.json(status);
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
    broadcastStats();
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
      broadcastStats();
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
    const logs = await getRecentLogs();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE Events endpoint
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  if (token !== adminPassword) {
    return res.status(401).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // Send initial data immediately to the newly connected client
  Promise.resolve().then(async () => {
    try {
      const stats = await getSystemStatus();
      res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);

      const logs = await getRecentLogs();
      res.write(`event: logs\ndata: ${JSON.stringify(logs)}\n\n`);

      const queues = getActiveQueues();
      res.write(`event: queues\ndata: ${JSON.stringify(queues)}\n\n`);

      const analytics = await getAnalyticsData();
      res.write(`event: analytics\ndata: ${JSON.stringify(analytics)}\n\n`);
    } catch (err) {
      console.error('[SSE] Error sending initial data:', err.message);
    }
  });

  req.on('close', () => {
    const index = sseClients.findIndex(c => c.id === clientId);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

// GET Analytics endpoint
app.get('/api/analytics', requireAuth, async (req, res) => {
  try {
    const data = await getAnalyticsData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET Active Queues endpoint
app.get('/api/active-queues', requireAuth, (req, res) => {
  res.json({ queues: getActiveQueues() });
});

// POST Stop User Queue endpoint
app.post('/api/active-queues/stop', requireAuth, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  const userData = userSpams.get(userId);
  if (userData && (userData.queue.length > 0 || userData.sending)) {
    userData.queue = [];
    broadcastQueues();
    res.json({ success: true, message: `Stopped active spam sequence for user ${userId}` });
  } else {
    res.status(404).json({ error: 'No active spam sequence found for this user' });
  }
});

// POST Purge User Queue endpoint
app.post('/api/active-queues/purge', requireAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  
  const userData = userSpams.get(userId);
  if (userData) {
    userData.queue = [];
    broadcastQueues();
    while (userData.sending) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (userData && userData.messages.length > 0) {
    const messagesToDelete = [...userData.messages];
    userData.messages = [];
    broadcastQueues();

    Promise.all(messagesToDelete.map(async (item) => {
      try {
        await item.webhook.deleteMessage(item.id);
        return true;
      } catch (webhookError) {
        try {
          const channel = await client.channels.fetch(item.channelId);
          const fetchedMsg = await channel.messages.fetch(item.id);
          await fetchedMsg.delete();
          return true;
        } catch (deleteError) {
          console.error(`[Purge Error] Failed to delete message ${item.id}:`, deleteError.message);
          return false;
        }
      }
    })).then(results => {
      const deletedCount = results.filter(Boolean).length;
      console.log(`[Purge] Cleaned up ${deletedCount} messages for user ${userId}`);
    });

    res.json({ success: true, message: `Purged active queue and ${messagesToDelete.length} messages for user ${userId}` });
  } else {
    res.status(404).json({ error: 'No messages found to delete for this user.' });
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

const sseClients = [];

async function getSystemStatus() {
  const discordLatency = client.ws.ping;
  const guildCount = client.isReady() ? client.guilds.cache.size : 0;
  
  let totalLogs = 0;
  let authorizedCount = authorizedUsers.length;

  if (databaseUrl) {
    const logsRes = await pool.query('SELECT COUNT(*) FROM spam_logs');
    totalLogs = parseInt(logsRes.rows[0].count, 10);

    const usersRes = await pool.query('SELECT COUNT(*) FROM authorized_users');
    authorizedCount = parseInt(usersRes.rows[0].count, 10);
  }

  return {
    status: client.isReady() ? 'Online' : 'Offline',
    uptime: Math.round(process.uptime()),
    latency: discordLatency >= 0 ? discordLatency : 0,
    guilds: guildCount,
    totalLogs,
    authorizedCount,
    ownerId
  };
}

async function getRecentLogs() {
  if (databaseUrl) {
    const logsRes = await pool.query(
      'SELECT user_id, username, guild_id, guild_name, channel_id, message_text, click_count, initiated_at FROM spam_logs ORDER BY initiated_at DESC LIMIT 50'
    );
    return logsRes.rows.map(row => {
      const cachedGuild = (row.guild_id && client.guilds && client.guilds.cache) ? client.guilds.cache.get(row.guild_id) : null;
      return {
        ...row,
        guild_name: row.guild_name || (cachedGuild ? cachedGuild.name : null)
      };
    });
  }
  return [];
}

function getActiveQueues() {
  const queues = [];
  userSpams.forEach((userData, userId) => {
    if (userData.queue.length > 0 || userData.sending) {
      queues.push({
        userId,
        username: userData.username || 'Unknown',
        queueLength: userData.queue.length,
        sending: userData.sending,
        currentMessage: userData.currentMessage || ''
      });
    }
  });
  return queues;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (err) {
      console.error('[SSE] Error writing to client:', err.message);
    }
  });
}

async function broadcastStats() {
  try {
    const stats = await getSystemStatus();
    broadcastSSE('stats', stats);
  } catch (err) {
    console.error('[SSE] Failed to broadcast stats:', err.message);
  }
}

async function broadcastLogs() {
  try {
    const logs = await getRecentLogs();
    broadcastSSE('logs', logs);
  } catch (err) {
    console.error('[SSE] Failed to broadcast logs:', err.message);
  }
}

function broadcastQueues() {
  try {
    const queues = getActiveQueues();
    broadcastSSE('queues', queues);
  } catch (err) {
    console.error('[SSE] Failed to broadcast queues:', err.message);
  }
}

async function getAnalyticsData() {
  if (!databaseUrl) {
    return {
      trend: Array.from({ length: 24 }, (_, i) => ({
        label: `${String(i).padStart(2, '0')}:00`,
        count: 0
      })),
      channels: [],
      users: []
    };
  }

  try {
    // 1. Hourly Trend (Asia/Kolkata timezone conversion)
    const trendRes = await pool.query(`
      SELECT 
        to_char(h, 'HH24:00') as label,
        COALESCE(SUM(s.click_count), 0)::integer as count
      FROM generate_series(
        date_trunc('hour', NOW() AT TIME ZONE 'Asia/Kolkata' - INTERVAL '23 hours'),
        date_trunc('hour', NOW() AT TIME ZONE 'Asia/Kolkata'),
        '1 hour'::interval
      ) h
      LEFT JOIN spam_logs s ON date_trunc('hour', s.initiated_at AT TIME ZONE 'Asia/Kolkata') = h
      GROUP BY h
      ORDER BY h ASC;
    `);

    // 2. Top Channels
    const channelsRes = await pool.query(`
      SELECT 
        channel_id,
        guild_id,
        COALESCE(SUM(click_count), 0)::integer as count
      FROM spam_logs 
      GROUP BY channel_id, guild_id 
      ORDER BY count DESC 
      LIMIT 5;
    `);

    const channels = channelsRes.rows.map(row => {
      let label = 'DM';
      if (row.channel_id) {
        const cachedChannel = (client.channels && client.channels.cache) ? client.channels.cache.get(row.channel_id) : null;
        if (cachedChannel) {
          const guildName = cachedChannel.guild?.name;
          label = guildName ? `#${cachedChannel.name} (${guildName})` : `#${cachedChannel.name}`;
        } else {
          const cachedGuild = (row.guild_id && client.guilds && client.guilds.cache) ? client.guilds.cache.get(row.guild_id) : null;
          label = cachedGuild ? `#${row.channel_id} (${cachedGuild.name})` : `#${row.channel_id}`;
        }
      }
      return {
        label,
        count: row.count
      };
    });

    // 3. Top Users
    const usersRes = await pool.query(`
      SELECT 
        user_id,
        username,
        COALESCE(SUM(click_count), 0)::integer as count
      FROM spam_logs 
      GROUP BY username, user_id 
      ORDER BY count DESC 
      LIMIT 5;
    `);

    const users = usersRes.rows.map(row => {
      let label = row.username;
      if (!label) {
        const cachedUser = (row.user_id && client.users && client.users.cache) ? client.users.cache.get(row.user_id) : null;
        label = cachedUser ? (cachedUser.tag || cachedUser.username) : row.user_id;
      }
      return {
        label,
        count: row.count
      };
    });

    return {
      trend: trendRes.rows,
      channels,
      users
    };
  } catch (err) {
    console.error('[Analytics Error] Failed to aggregate analytics:', err.message);
    return { trend: [], channels: [], users: [] };
  }
}

async function broadcastAnalytics() {
  try {
    const data = await getAnalyticsData();
    broadcastSSE('analytics', data);
  } catch (err) {
    console.error('[SSE] Failed to broadcast analytics:', err.message);
  }
}



// Helper to process a user's spam queue sequentially
async function processQueue(userId) {
  const userData = userSpams.get(userId);
  if (!userData || userData.sending || userData.queue.length === 0) {
    return;
  }

  userData.sending = true;
  broadcastQueues();

  try {
    while (userData.queue.length > 0) {
      const item = userData.queue.shift();
      broadcastQueues();

      try {
        const sendOptions = {
          tts: item.tts || false
        };

        if (item.embed) {
          let hexColor = 0x5865F2; 
          if (item.embedColor) {
            try {
              hexColor = parseInt(item.embedColor.replace('#', ''), 16);
            } catch (err) {}
          }
          
          const embedData = {
            color: hexColor,
            title: item.embedTitle || null,
            description: item.messageText,
            timestamp: new Date().toISOString(),
            footer: {
              text: 'Panda Spammer Pro 🐼'
            }
          };

          if (item.embedImageUrl) {
            embedData.image = { url: item.embedImageUrl };
          }

          sendOptions.embeds = [embedData];
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

        // Self-Destruct timer execution (asynchronous timeout)
        if (item.selfDestruct && item.selfDestruct > 0) {
          setTimeout(async () => {
            try {
              await item.interaction.webhook.deleteMessage(msg.id);
              console.log(`[Self-Destruct] Auto-deleted message ${msg.id}`);
            } catch (webhookError) {
              try {
                const channel = await client.channels.fetch(msg.channelId);
                const fetchedMsg = await channel.messages.fetch(msg.id);
                await fetchedMsg.delete();
                console.log(`[Self-Destruct] Auto-deleted message ${msg.id} via API fallback`);
              } catch (deleteError) {
                console.error(`[Self-Destruct Error] Failed to delete message ${msg.id}:`, deleteError.message);
              }
            }
          }, item.selfDestruct * 1000);
        }
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
    broadcastQueues();
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
        const selfDestruct = interaction.options.getInteger('self_destruct') ?? 0;

        const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

        if (databaseUrl) {
          await pool.query(
            'INSERT INTO spam_sessions (session_id, message_text, spam_count, delay_ms, use_tts, use_embed, self_destruct_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [sessionId, message, count, delay, tts, embed, selfDestruct]
          );
        } else {
          localSpamSessions.set(sessionId, {
            message_text: message,
            spam_count: count,
            delay_ms: delay,
            use_tts: tts,
            use_embed: embed,
            self_destruct_seconds: selfDestruct
          });
        }

        const buttonLabel = `Spam 5x` + (embed ? ' (Embed)' : '') + (tts ? ' (TTS)' : '') + (selfDestruct > 0 ? ' (💥)' : '');
        const button = new ButtonBuilder()
          .setCustomId(`spam_click:${sessionId}`)
          .setLabel(buttonLabel)
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
          content: `⚙️ **Spam Configured:**\n* **Quantity:** 5 messages (Fixed)\n* **Delay:** ${delay}ms\n* **TTS:** ${tts ? 'Enabled' : 'Disabled'}\n* **Format:** ${embed ? 'Rich Embed' : 'Plain Text'}\n* **Self-Destruct:** ${selfDestruct > 0 ? `${selfDestruct} seconds` : 'Disabled'}\n\nClick the button below to initiate.`,
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

    else if (commandName === 'customspam') {
      try {
        const modal = new ModalBuilder()
          .setCustomId('custom_embed_modal')
          .setTitle('Custom Embed Spammer');

        const titleInput = new TextInputBuilder()
          .setCustomId('embed_title')
          .setLabel('Embed Title')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter the title for your embed')
          .setRequired(true);

        const descInput = new TextInputBuilder()
          .setCustomId('embed_description')
          .setLabel('Embed Description (Message Body)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Type your main spam message here')
          .setRequired(true);

        const colorInput = new TextInputBuilder()
          .setCustomId('embed_color')
          .setLabel('Accent Color (Hex Code e.g. #00f2fe)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('#5865F2')
          .setRequired(false);

        const imageInput = new TextInputBuilder()
          .setCustomId('embed_image_url')
          .setLabel('Embed Image URL')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://example.com/image.png')
          .setRequired(false);

        const selfDestructInput = new TextInputBuilder()
          .setCustomId('self_destruct')
          .setLabel('Self-Destruct Timer (Seconds, e.g. 10)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank to disable auto-delete')
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descInput),
          new ActionRowBuilder().addComponents(colorInput),
          new ActionRowBuilder().addComponents(imageInput),
          new ActionRowBuilder().addComponents(selfDestructInput)
        );

        await interaction.showModal(modal);
      } catch (error) {
        console.error('Error opening customspam modal:', error);
        await interaction.reply({
          content: '❌ Failed to open the custom embed modal.',
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
          broadcastQueues();
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
          broadcastQueues();
          // Wait for the active in-flight message to finish if sending is true
          while (userData.sending) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }

        if (userData && userData.messages.length > 0) {
          // Deleting messages
          const messagesToDelete = [...userData.messages];
          userData.messages = []; // Clear local list immediately to prevent double-deletes
          broadcastQueues();

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
          let content = `👑 **Authorized Users List** (Database):\n**Owner:** <@${ownerId}>\n\n`;
          let addedCount = 0;
          for (let i = 0; i < res.rows.length; i++) {
            const row = res.rows[i];
            const dateStr = row.added_at ? new Date(row.added_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'N/A';
            const line = `${i + 1}. <@${row.user_id}> (ID: ${row.user_id}) - Added by <@${row.added_by}> at ${dateStr}\n`;
            
            if (content.length + line.length > 1900) {
              const remaining = res.rowCount - addedCount;
              content += `⚠️ *Truncated ${remaining} more users due to Discord length limits. View them all on the Web Dashboard!*`;
              break;
            }
            content += line;
            addedCount++;
          }

          await interaction.reply({
            content: content,
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
          'SELECT user_id, username, guild_id, guild_name, channel_id, message_text, click_count, initiated_at FROM spam_logs ORDER BY initiated_at DESC LIMIT 15'
        );

        if (res.rowCount > 0) {
          let content = `📋 **Recent Spam Logs (Last 15):**\n\n`;
          let addedCount = 0;
          for (const row of res.rows) {
            const dateStr = row.initiated_at ? new Date(row.initiated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'N/A';
            const cachedGuild = (row.guild_id && client.guilds && client.guilds.cache) ? client.guilds.cache.get(row.guild_id) : null;
            const resolvedGuildName = row.guild_name || (cachedGuild ? cachedGuild.name : null);
            const server = resolvedGuildName ? `**${resolvedGuildName}**` : (row.guild_id ? `Server ID: \`${row.guild_id}\`` : 'DM');
            const channel = row.channel_id ? `<#${row.channel_id}> (\`${row.channel_id}\`)` : 'N/A';
            const clicks = row.click_count || 1;
            const cleanText = row.message_text.replace(/`/g, '\\`').slice(0, 100);
            const line = `📅 **${dateStr}** (Clicks: **${clicks}**)\n👤 **User:** <@${row.user_id}> (\`${row.username || row.user_id}\`)\n🌐 **Location:** ${server} | **Channel:** ${channel}\n💬 **Message:** \`${cleanText}\`\n\n`;
            
            if (content.length + line.length > 1900) {
              const remaining = res.rowCount - addedCount;
              content += `⚠️ *Truncated ${remaining} more entries due to Discord length limits. View them all on the Web Dashboard!*`;
              break;
            }
            content += line;
            addedCount++;
          }

          await interaction.reply({
            content: content,
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
        if (stopCount > 0) {
          broadcastQueues();
        }

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
        broadcastQueues();

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
        broadcastQueues();

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

  // 3. Handle Modal Submissions
  else if (interaction.type === InteractionType.ModalSubmit) {
    const { customId } = interaction;

    if (customId === 'custom_embed_modal') {
      try {
        const title = interaction.fields.getTextInputValue('embed_title');
        const description = interaction.fields.getTextInputValue('embed_description');
        const color = interaction.fields.getTextInputValue('embed_color') || '#5865F2';
        const imageUrl = interaction.fields.getTextInputValue('embed_image_url') || '';
        const selfDestructStr = interaction.fields.getTextInputValue('self_destruct');
        const selfDestruct = parseInt(selfDestructStr, 10) || 0;

        const count = 5; 
        const delay = 100; 

        const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

        if (databaseUrl) {
          await pool.query(
            'INSERT INTO spam_sessions (session_id, message_text, spam_count, delay_ms, use_tts, use_embed, self_destruct_seconds, embed_title, embed_image_url, embed_color) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [sessionId, description, count, delay, false, true, selfDestruct, title, imageUrl, color]
          );
        } else {
          localSpamSessions.set(sessionId, {
            message_text: description,
            spam_count: count,
            delay_ms: delay,
            use_tts: false,
            use_embed: true,
            self_destruct_seconds: selfDestruct,
            embed_title: title,
            embed_image_url: imageUrl,
            embed_color: color
          });
        }

        const buttonLabel = `Spam 5x (Embed)` + (selfDestruct > 0 ? ' (💥)' : '');
        const button = new ButtonBuilder()
          .setCustomId(`spam_click:${sessionId}`)
          .setLabel(buttonLabel)
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
          content: `⚙️ **Custom Embed Configured:**\n* **Title:** ${title}\n* **Accent Color:** ${color}\n* **Image:** ${imageUrl || 'None'}\n* **Self-Destruct:** ${selfDestruct > 0 ? `${selfDestruct} seconds` : 'Disabled'}\n\nClick the button below to initiate.`,
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error handling custom embed modal submit:', error);
        await interaction.reply({
          content: '❌ An error occurred while saving your custom embed config.',
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
              'SELECT message_text, spam_count, delay_ms, use_tts, use_embed, self_destruct_seconds, embed_title, embed_image_url, embed_color FROM spam_sessions WHERE session_id = $1',
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
        const selfDestruct = session.self_destruct_seconds || 0;
        const embedTitle = session.embed_title || null;
        const embedImageUrl = session.embed_image_url || null;
        const embedColor = session.embed_color || null;

        // Initialize user entry if not exists
        if (!userSpams.has(userId)) {
          userSpams.set(userId, { queue: [], sending: false, messages: [], username: interaction.user.tag || interaction.user.username });
        }
        const userData = userSpams.get(userId);
        userData.username = interaction.user.tag || interaction.user.username;
        userData.currentMessage = messageText;

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
              const guildName = interaction.guild ? interaction.guild.name : null;
              await pool.query(
                'INSERT INTO spam_logs (user_id, username, guild_id, guild_name, channel_id, message_text, click_count) VALUES ($1, $2, $3, $4, $5, $6, 1)',
                [
                  userId,
                  interaction.user.tag || interaction.user.username,
                  interaction.guildId || null,
                  guildName,
                  interaction.channelId || null,
                  messageText.slice(0, 200)
                ]
              );
            }
            broadcastLogs();
            broadcastStats();
            broadcastAnalytics();
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
            delay,
            selfDestruct,
            embedTitle,
            embedImageUrl,
            embedColor
          });
        }
        broadcastQueues();

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
