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
  InteractionType,
  WebhookClient,
  PermissionsBitField
} from 'discord.js';
import 'dotenv/config';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const databaseUrl = process.env.DATABASE_URL;
const ownerId = process.env.OWNER_ID;
const clientSecret = process.env.CLIENT_SECRET;
const redirectUri = process.env.REDIRECT_URI;

const authorizedUsers = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(',').map(id => id.trim())
  : [];

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl ? { rejectUnauthorized: false } : false
});

// Advanced Features Global State
const activeSessions = new Map();
const localErrorLogs = [];
const channelWebhooksCache = new Map();
const channelWebhookIndex = new Map();

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
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS ghost_spam BOOLEAN DEFAULT FALSE');
      await pool.query('ALTER TABLE spam_sessions ADD COLUMN IF NOT EXISTS panda_raid BOOLEAN DEFAULT FALSE');
    } catch (alterErr) {
      console.warn('[Database] Alter spam_sessions warning:', alterErr.message);
    }
    
    // Create new tables for advanced features
    await pool.query(`
      CREATE TABLE IF NOT EXISTS active_queues (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(30) NOT NULL,
        username VARCHAR(100),
        guild_id VARCHAR(30),
        channel_id VARCHAR(30) NOT NULL,
        message_text TEXT NOT NULL,
        delay_ms INTEGER DEFAULT 100,
        use_tts BOOLEAN DEFAULT FALSE,
        use_embed BOOLEAN DEFAULT FALSE,
        self_destruct_seconds INTEGER DEFAULT 0,
        ghost_spam BOOLEAN DEFAULT FALSE,
        panda_raid BOOLEAN DEFAULT FALSE,
        embed_title VARCHAR(200) NULL,
        embed_image_url VARCHAR(500) NULL,
        embed_color VARCHAR(10) NULL,
        interaction_token TEXT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sent_messages (
        id VARCHAR(30) PRIMARY KEY,
        user_id VARCHAR(30) NOT NULL,
        channel_id VARCHAR(30) NOT NULL,
        webhook_id VARCHAR(30) NULL,
        webhook_token TEXT NULL,
        interaction_token TEXT NULL,
        sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY,
        error_message TEXT NOT NULL,
        error_code VARCHAR(50) NULL,
        user_id VARCHAR(30) NULL,
        channel_id VARCHAR(30) NULL,
        guild_id VARCHAR(30) NULL,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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

// Start an Express HTTP server with dashboard routing and JSON parsing
const app = express();
const port = process.env.PORT || 3000;
const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

app.use(express.json());
app.use(express.static('public'));

// Password & Session authorization middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (token === adminPassword) {
    req.userId = ownerId || 'WebOwner';
    req.username = 'Dashboard Owner';
    return next();
  }

  const session = activeSessions.get(token);
  if (session && session.expiresAt > Date.now()) {
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000; // extend session
    req.userId = session.userId;
    req.username = session.username;
    return next();
  }

  res.status(401).json({ error: 'Unauthorized' });
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

// Config endpoint to expose OAuth status
app.get('/api/config', (req, res) => {
  const clientIdEnv = process.env.CLIENT_ID;
  res.json({
    oauthEnabled: !!(clientIdEnv && clientSecret && redirectUri)
  });
});

// OAuth2 Url generator
app.get('/api/auth/url', (req, res) => {
  const clientIdEnv = process.env.CLIENT_ID;
  if (!clientIdEnv || !redirectUri) {
    return res.status(400).json({ error: 'OAuth2 configuration is incomplete.' });
  }
  const url = `https://discord.com/api/oauth2/authorize?client_id=${clientIdEnv}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
  res.json({ url });
});

// OAuth2 Callback handler
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  const clientIdEnv = process.env.CLIENT_ID;
  if (!code) {
    return res.redirect('/?error=No+authorization+code+provided');
  }

  try {
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientIdEnv,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('[OAuth2] Token exchange failed:', tokenData);
      return res.redirect(`/?error=${encodeURIComponent(tokenData.error_description || 'Token exchange failed')}`);
    }

    const accessToken = tokenData.access_token;

    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const userData = await userResponse.json();
    if (!userResponse.ok) {
      console.error('[OAuth2] Fetching user info failed:', userData);
      return res.redirect('/?error=Failed+to+fetch+user+info');
    }

    const userId = userData.id;
    const authorized = await isUserAuthorized(userId);
    if (!authorized) {
      return res.redirect('/?error=You+are+not+authorized+to+access+the+dashboard');
    }

    const sessionToken = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const userTag = userData.discriminator && userData.discriminator !== '0' 
      ? `${userData.username}#${userData.discriminator}` 
      : userData.username;

    activeSessions.set(sessionToken, {
      userId,
      username: userTag,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });

    res.redirect(`/?token=${sessionToken}`);
  } catch (err) {
    console.error('[OAuth2] Auth Callback Error:', err);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// Diagnostics Logs endpoint
app.get('/api/diagnostics', requireAuth, async (req, res) => {
  try {
    const errors = await getDiagnosticsData();
    res.json({ errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Web Console Spam Trigger endpoint
app.post('/api/spam/trigger', requireAuth, async (req, res) => {
  const {
    channelId,
    messageText,
    delay = 100,
    tts = false,
    embed = false,
    selfDestruct = 0,
    ghostSpam = false,
    pandaRaid = false,
    embedTitle = '',
    embedImageUrl = '',
    embedColor = ''
  } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: 'Target Channel ID is required' });
  }
  if (!pandaRaid && !messageText) {
    return res.status(400).json({ error: 'Message Text is required when Panda Raid is disabled' });
  }

  const userId = req.userId;
  const username = req.username;

  try {
    const count = 5;
    const sessionItems = [];

    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return res.status(400).json({ error: `Channel ${channelId} could not be resolved or bot is not in that guild.` });
    }

    if (databaseUrl) {
      for (let i = 0; i < count; i++) {
        const insertRes = await pool.query(
          `INSERT INTO active_queues (
            user_id, username, guild_id, channel_id, message_text, delay_ms, use_tts, use_embed, 
            self_destruct_seconds, ghost_spam, panda_raid, embed_title, embed_image_url, embed_color
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
          [
            userId, username, channel.guild?.id || null, channelId, messageText || '', delay, tts, embed,
            selfDestruct, ghostSpam, pandaRaid, embedTitle || null, embedImageUrl || null, embedColor || null
          ]
        );
        sessionItems.push({
          dbQueueId: insertRes.rows[0].id,
          messageText,
          channelId,
          tts,
          embed,
          delay,
          selfDestruct,
          ghostSpam,
          pandaRaid,
          embedTitle,
          embedImageUrl,
          embedColor,
          itemIndex: i
        });
      }
    } else {
      for (let i = 0; i < count; i++) {
        sessionItems.push({
          messageText,
          channelId,
          tts,
          embed,
          delay,
          selfDestruct,
          ghostSpam,
          pandaRaid,
          embedTitle,
          embedImageUrl,
          embedColor,
          itemIndex: i
        });
      }
    }

    if (!userSpams.has(userId)) {
      userSpams.set(userId, { queue: [], sending: false, messages: [], username });
    }
    const userData = userSpams.get(userId);
    userData.username = username;
    userData.currentMessage = pandaRaid ? '🐼 Panda Raid Active!' : messageText;

    if (databaseUrl) {
      try {
        const guildName = channel.guild ? channel.guild.name : null;
        await pool.query(
          'INSERT INTO spam_logs (user_id, username, guild_id, guild_name, channel_id, message_text, click_count) VALUES ($1, $2, $3, $4, $5, $6, 1)',
          [
            userId,
            username,
            channel.guildId || null,
            guildName,
            channelId,
            (pandaRaid ? '🐼 Panda Raid' : messageText).slice(0, 200)
          ]
        );
        broadcastLogs();
        broadcastStats();
        broadcastAnalytics();
      } catch (dbErr) {
        console.error('[Database] Failed to log dashboard spam trigger:', dbErr.message);
      }
    }

    userData.queue.push(...sessionItems);
    broadcastQueues();

    processQueue(userId);

    res.json({ success: true, message: `Spam queue initiated successfully for channel ${channelId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const isValidSession = activeSessions.has(token) && activeSessions.get(token).expiresAt > Date.now();
  if (token !== adminPassword && !isValidSession) {
    return res.status(401).end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sseClientId = Date.now();
  const newClient = { id: sseClientId, res };
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

      const errors = await getDiagnosticsData();
      res.write(`event: diagnostics\ndata: ${JSON.stringify(errors)}\n\n`);
    } catch (err) {
      console.error('[SSE] Error sending initial data:', err.message);
    }
  });

  req.on('close', () => {
    const index = sseClients.findIndex(c => c.id === sseClientId);
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



// Global error logging helper
async function logError(errMessage, errCode = null, userId = null, channelId = null, guildId = null) {
  console.error(`[Error Log] ${errMessage} (Code: ${errCode})`);
  if (databaseUrl) {
    try {
      await pool.query(
        'INSERT INTO error_logs (error_message, error_code, user_id, channel_id, guild_id) VALUES ($1, $2, $3, $4, $5)',
        [errMessage, errCode, userId, channelId, guildId]
      );
      broadcastDiagnostics();
    } catch (dbErr) {
      console.error('[Database] Failed to save error log:', dbErr.message);
    }
  } else {
    localErrorLogs.unshift({
      id: Date.now() + Math.random(),
      error_message: errMessage,
      error_code: errCode,
      user_id: userId,
      channel_id: channelId,
      guild_id: guildId,
      timestamp: new Date()
    });
    if (localErrorLogs.length > 50) localErrorLogs.pop();
    broadcastDiagnostics();
  }
}

async function getDiagnosticsData() {
  if (databaseUrl) {
    try {
      const dbRes = await pool.query('SELECT id, error_message, error_code, user_id, channel_id, guild_id, timestamp FROM error_logs ORDER BY timestamp DESC LIMIT 50');
      return dbRes.rows;
    } catch (err) {
      console.error('[Database] Failed to fetch error logs for diagnostics:', err.message);
      return [];
    }
  }
  return localErrorLogs;
}

async function broadcastDiagnostics() {
  try {
    const data = await getDiagnosticsData();
    broadcastSSE('diagnostics', data);
  } catch (err) {
    console.error('[SSE] Failed to broadcast diagnostics:', err.message);
  }
}

// Formatting dynamic spam variables
function formatSpamMessage(text, index, userId) {
  let formatted = text || '';
  formatted = formatted.replace(/{count}/g, (index + 1).toString());
  
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  formatted = formatted.replace(/{time}/g, timeStr);
  
  const emojis = ['🐼', '🐨', '🐾', '🍃', '🎋', '✨', '🔥', '💥', '⚡', '🎉', '❤️', '🌟'];
  formatted = formatted.replace(/{random_emoji}/g, () => emojis[Math.floor(Math.random() * emojis.length)]);
  
  if (userId) {
    formatted = formatted.replace(/{ping_user}/g, `<@${userId}>`);
  }
  
  return formatted;
}

// Multi-message rotation and variable replacement
function processSpamText(text, index, userId) {
  let baseText = text || '';
  if (baseText.includes('||')) {
    const parts = baseText.split('||').map(p => p.trim());
    baseText = parts[index % parts.length];
  }
  return formatSpamMessage(baseText, index, userId);
}

// Webhook Auto-Rotation (bypassing rate limits)
async function getRotatedWebhook(channel, clientUser) {
  const channelId = channel.id;
  if (!channel.guild || !channel.createWebhook || !channel.fetchWebhooks) {
    return null;
  }

  // Resolve bot member permissions
  const botMember = channel.guild.members.cache.get(clientUser.id) || await channel.guild.members.fetch(clientUser.id).catch(() => null);
  if (!botMember) return null;
  
  const permissions = channel.permissionsFor(botMember);
  if (!permissions || !permissions.has(PermissionsBitField.Flags.ManageWebhooks) || !permissions.has(PermissionsBitField.Flags.SendMessages)) {
    return null;
  }

  if (channelWebhooksCache.has(channelId)) {
    const cached = channelWebhooksCache.get(channelId);
    if (cached && cached.length > 0) {
      return getNextWebhookFromCache(channelId, cached);
    }
  }

  try {
    const webhooks = await channel.fetchWebhooks();
    const prefix = 'Panda Helper ';
    let helpers = webhooks.filter(wh => wh.name.startsWith(prefix));
    let helperList = Array.from(helpers.values());

    const desiredCount = 3;
    const currentCount = helperList.length;
    
    if (currentCount < desiredCount) {
      const avatarUrl = clientUser.displayAvatarURL() || null;
      for (let i = currentCount + 1; i <= desiredCount; i++) {
        try {
          const newWh = await channel.createWebhook({
            name: `${prefix}${i}`,
            avatar: avatarUrl,
            reason: 'Panda Spam Bot Webhook Rotation'
          });
          helperList.push(newWh);
        } catch (createErr) {
          console.warn(`[Webhook Pool] Failed to create webhook ${prefix}${i}:`, createErr.message);
          break;
        }
      }
    }

    if (helperList.length > 0) {
      channelWebhooksCache.set(channelId, helperList);
      return getNextWebhookFromCache(channelId, helperList);
    }
  } catch (err) {
    console.warn(`[Webhook Pool] Error fetching/creating webhooks for channel ${channelId}:`, err.message);
  }

  return null;
}

function getNextWebhookFromCache(channelId, webhooks) {
  let idx = channelWebhookIndex.get(channelId) || 0;
  const webhook = webhooks[idx % webhooks.length];
  channelWebhookIndex.set(channelId, (idx + 1) % webhooks.length);
  return webhook;
}

// Sequential queue worker
async function processQueue(userId) {
  const userData = userSpams.get(userId);
  if (!userData || userData.sending || userData.queue.length === 0) {
    return;
  }

  userData.sending = true;
  broadcastQueues();

  try {
    let sentCount = 0;
    while (userData.queue.length > 0) {
      const item = userData.queue.shift();
      broadcastQueues();

      const itemIndex = item.itemIndex ?? sentCount;
      sentCount++;

      try {
        let finalContent = '';
        if (item.pandaRaid) {
          const pandaRaidMessages = [
            "🐼 Panda Raid! Cute pandas are taking over! 🎋",
            "🐼 *Rolls into the channel* 🎋",
            "🐼 Did you know? Giant pandas spend 12 hours a day eating bamboo! 🎋",
            "🐼 Panda Power! ✨🐾✨",
            "🐼 🎋 🐼 🎋 🐼 🎋 🐼 🎋 🐼",
            "🐼 P-A-N-D-A! *dances around* 🐼"
          ];
          finalContent = pandaRaidMessages[itemIndex % pandaRaidMessages.length];
        } else {
          finalContent = processSpamText(item.messageText, itemIndex, userId);
        }

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
            title: item.embedTitle ? formatSpamMessage(item.embedTitle, itemIndex, userId) : null,
            description: finalContent,
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
          sendOptions.content = finalContent;
        }

        const targetChannelId = item.channelId || item.interaction?.channelId;
        if (!targetChannelId) {
          throw new Error('Target channel ID not found.');
        }

        const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
        const hasInteraction = !!(item.interaction || item.interactionToken || item.interaction?.token);
        if (!channel && !hasInteraction) {
          throw new Error(`Channel ${targetChannelId} could not be resolved.`);
        }

        let msgId = null;
        let sentWebhook = null;
        let viaWebhook = false;

        if (channel) {
          const webhook = await getRotatedWebhook(channel, client.user);
          if (webhook) {
            try {
              const webhookSendOptions = {
                username: 'Panda Spammer Helper',
                avatarURL: client.user.displayAvatarURL(),
                wait: true,
                ...sendOptions
              };
              const response = await webhook.send(webhookSendOptions);
              msgId = response.id;
              sentWebhook = webhook;
              viaWebhook = true;
            } catch (webhookErr) {
              await logError(`Webhook send failed, falling back: ${webhookErr.message}`, webhookErr.code, userId, targetChannelId, channel.guild?.id);
            }
          }
        }

        if (!msgId && item.interaction) {
          try {
            const msg = await item.interaction.followUp(sendOptions);
            msgId = msg.id;
          } catch (intErr) {
            await logError(`Interaction followUp failed: ${intErr.message}`, intErr.code, userId, targetChannelId, channel?.guild?.id);
          }
        }

        const interactionToken = item.interactionToken || item.interaction?.token;
        if (!msgId && interactionToken && clientId) {
          try {
            const wh = new WebhookClient({ id: clientId, token: interactionToken });
            const response = await wh.send(sendOptions);
            msgId = response.id;
            sentWebhook = wh;
            viaWebhook = true;
          } catch (intErr) {
            await logError(`Interaction token send failed: ${intErr.message}`, intErr.code, userId, targetChannelId, channel?.guild?.id);
          }
        }

        if (!msgId) {
          if (!channel) {
            throw new Error(`Channel ${targetChannelId} could not be resolved and no valid interaction token was available for fallback.`);
          }
          try {
            const msg = await channel.send(sendOptions);
            msgId = msg.id;
          } catch (sendErr) {
            await logError(`Direct channel send failed: ${sendErr.message}`, sendErr.code, userId, targetChannelId, channel.guild?.id);
            throw sendErr;
          }
        }

        const messageTracker = {
          id: msgId,
          channelId: targetChannelId,
          webhook: viaWebhook && sentWebhook ? {
            deleteMessage: async (id) => sentWebhook.deleteMessage(id)
          } : (item.interaction ? {
            deleteMessage: async (id) => item.interaction.webhook.deleteMessage(id)
          } : null)
        };
        userData.messages.push(messageTracker);

        if (databaseUrl) {
          try {
            const whId = viaWebhook ? sentWebhook.id : null;
            const whToken = viaWebhook ? sentWebhook.token : null;
            const intToken = (!viaWebhook && item.interaction) ? item.interaction.token : null;
            await pool.query(
              'INSERT INTO sent_messages (id, user_id, channel_id, webhook_id, webhook_token, interaction_token) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
              [msgId, userId, targetChannelId, whId, whToken, intToken]
            );
          } catch (dbErr) {
            console.error('[Database] Failed to persist sent message record:', dbErr.message);
          }
        }

        if (databaseUrl && item.dbQueueId) {
          try {
            await pool.query('DELETE FROM active_queues WHERE id = $1', [item.dbQueueId]);
          } catch (dbErr) {
            console.error('[Database] Failed to delete queue item:', dbErr.message);
          }
        }

        const selfDestructSec = item.selfDestruct || 0;
        const isGhost = item.ghostSpam || false;
        
        if (isGhost) {
          setTimeout(async () => {
            await deleteMessageTracked(messageTracker, userId);
          }, 500);
        } else if (selfDestructSec > 0) {
          setTimeout(async () => {
            await deleteMessageTracked(messageTracker, userId);
          }, selfDestructSec * 1000);
        }

      } catch (itemErr) {
        console.error(`[Spam Queue Item Failure] user ${userId}:`, itemErr.message);
        await logError(`Spam Queue Item Failure: ${itemErr.message}`, itemErr.code || null, userId, item.channelId || null, null);
        if (databaseUrl && item.dbQueueId) {
          try {
            await pool.query('DELETE FROM active_queues WHERE id = $1', [item.dbQueueId]);
          } catch (dbErr) {
            console.error('[Database] Failed to delete queue item after failure:', dbErr.message);
          }
        }

        // Clean up remaining queue items if the error is fatal (expired token or missing channel access)
        const isFatal = 
          itemErr.code === 50027 || // Invalid Webhook Token
          itemErr.code === 10015 || // Unknown Webhook
          itemErr.code === 50001 || // Missing Access
          itemErr.message.includes('could not be resolved') ||
          itemErr.message.includes('Missing Access');

        if (isFatal) {
          console.warn(`[Queue Worker] Fatal error encountered. Clearing remaining ${userData.queue.length} queue items for user ${userId} to prevent log spam.`);
          if (databaseUrl && userData.queue.length > 0) {
            const dbQueueIds = userData.queue.map(q => q.dbQueueId).filter(Boolean);
            if (dbQueueIds.length > 0) {
              try {
                await pool.query('DELETE FROM active_queues WHERE id = ANY($1)', [dbQueueIds]);
                console.log(`[Database] Cleaned up ${dbQueueIds.length} stale queue items for user ${userId}.`);
              } catch (dbErr) {
                console.error('[Database] Failed to bulk delete stale queue items:', dbErr.message);
              }
            }
          }
          userData.queue = [];
          broadcastQueues();
        }
      }

      if (userData.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, item.delay || 100));
      }
    }
  } finally {
    userData.sending = false;
    broadcastQueues();
  }
}

// Delete tracker helper
async function deleteMessageTracked(tracker, userId) {
  try {
    if (tracker.webhook && typeof tracker.webhook.deleteMessage === 'function') {
      await tracker.webhook.deleteMessage(tracker.id);
    } else {
      const channel = await client.channels.fetch(tracker.channelId);
      const fetchedMsg = await channel.messages.fetch(tracker.id);
      await fetchedMsg.delete();
    }
    console.log(`[Unsend/Cleanup] Deleted message ${tracker.id}`);
  } catch (err) {
    console.warn(`[Unsend/Cleanup Error] Failed to delete message ${tracker.id}: ${err.message}`);
  }
  
  if (databaseUrl) {
    try {
      await pool.query('DELETE FROM sent_messages WHERE id = $1', [tracker.id]);
    } catch (dbErr) {
      console.error('[Database] Failed to delete sent_message record:', dbErr.message);
    }
  }
  
  const userData = userSpams.get(userId);
  if (userData) {
    userData.messages = userData.messages.filter(m => m.id !== tracker.id);
    broadcastQueues();
  }
}

// Recover active queues from DB on startup
async function recoverQueues() {
  if (!databaseUrl) return;
  try {
    const res = await pool.query('SELECT * FROM active_queues ORDER BY created_at ASC');
    if (res.rowCount === 0) return;

    console.log(`[Queue Recovery] Recovered ${res.rowCount} queued messages from database. Resuming...`);

    const userItemsMap = new Map();
    for (const row of res.rows) {
      if (!userItemsMap.has(row.user_id)) {
        userItemsMap.set(row.user_id, []);
      }
      userItemsMap.get(row.user_id).push(row);
    }

    for (const [userId, items] of userItemsMap) {
      if (!userSpams.has(userId)) {
        userSpams.set(userId, {
          queue: [],
          sending: false,
          messages: [],
          username: items[0].username || 'Unknown'
        });
      }
      const userData = userSpams.get(userId);
      
      const sentMsgsRes = await pool.query('SELECT id, channel_id, webhook_id, webhook_token, interaction_token FROM sent_messages WHERE user_id = $1', [userId]);
      userData.messages = sentMsgsRes.rows.map(sm => ({
        id: sm.id,
        channelId: sm.channel_id,
        webhook: sm.webhook_id ? {
          deleteMessage: async (msgId) => {
            const wh = new WebhookClient({ id: sm.webhook_id, token: sm.webhook_token });
            return wh.deleteMessage(msgId);
          }
        } : (sm.interaction_token ? {
          deleteMessage: async (msgId) => {
            const wh = new WebhookClient({ id: clientId, token: sm.interaction_token });
            return wh.deleteMessage(msgId);
          }
        } : null)
      }));

      for (const item of items) {
        userData.queue.push({
          dbQueueId: item.id,
          messageText: item.message_text,
          channelId: item.channel_id,
          tts: item.use_tts,
          embed: item.use_embed,
          delay: item.delay_ms,
          selfDestruct: item.self_destruct_seconds,
          ghostSpam: item.ghost_spam,
          pandaRaid: item.panda_raid,
          embedTitle: item.embed_title,
          embedImageUrl: item.embed_image_url,
          embedColor: item.embed_color,
          interactionToken: item.interaction_token
        });
      }
      
      processQueue(userId);
    }
  } catch (err) {
    console.error('[Queue Recovery] Failed to recover active queues:', err.message);
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

  // Recover active queues from database
  await recoverQueues();

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
        const ghostSpam = interaction.options.getBoolean('ghost_spam') ?? false;
        const pandaRaid = interaction.options.getBoolean('panda_raid') ?? false;

        const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

        if (databaseUrl) {
          await pool.query(
            'INSERT INTO spam_sessions (session_id, message_text, spam_count, delay_ms, use_tts, use_embed, self_destruct_seconds, ghost_spam, panda_raid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [sessionId, message, count, delay, tts, embed, selfDestruct, ghostSpam, pandaRaid]
          );
        } else {
          localSpamSessions.set(sessionId, {
            message_text: message,
            spam_count: count,
            delay_ms: delay,
            use_tts: tts,
            use_embed: embed,
            self_destruct_seconds: selfDestruct,
            ghost_spam: ghostSpam,
            panda_raid: pandaRaid
          });
        }

        const buttonLabel = `Spam 5x` + (embed ? ' (Embed)' : '') + (tts ? ' (TTS)' : '') + (selfDestruct > 0 ? ' (💥)' : '') + (ghostSpam ? ' (👻)' : '') + (pandaRaid ? ' (🐼)' : '');
        const button = new ButtonBuilder()
          .setCustomId(`spam_click:${sessionId}`)
          .setLabel(buttonLabel)
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
          content: `⚙️ **Spam Configured:**\n* **Quantity:** 5 messages (Fixed)\n* **Delay:** ${delay}ms\n* **TTS:** ${tts ? 'Enabled' : 'Disabled'}\n* **Format:** ${embed ? 'Rich Embed' : 'Plain Text'}\n* **Self-Destruct:** ${selfDestruct > 0 ? `${selfDestruct} seconds` : 'Disabled'}\n* **Ghost Spam:** ${ghostSpam ? 'Enabled 👻' : 'Disabled'}\n* **Panda Raid:** ${pandaRaid ? 'Enabled 🐼' : 'Disabled'}\n\nClick the button below to initiate.`,
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

        let messagesToDelete = [];
        if (databaseUrl) {
          try {
            const dbRes = await pool.query('SELECT id, channel_id, webhook_id, webhook_token, interaction_token FROM sent_messages WHERE user_id = $1', [userId]);
            messagesToDelete = dbRes.rows.map(sm => ({
              id: sm.id,
              channelId: sm.channel_id,
              webhook: sm.webhook_id ? {
                deleteMessage: async (msgId) => {
                  const wh = new WebhookClient({ id: sm.webhook_id, token: sm.webhook_token });
                  return wh.deleteMessage(msgId);
                }
              } : (sm.interaction_token ? {
                deleteMessage: async (msgId) => {
                  const wh = new WebhookClient({ id: clientId, token: sm.interaction_token });
                  return wh.deleteMessage(msgId);
                }
              } : null)
            }));
          } catch (dbErr) {
            console.error('[Database] Failed to fetch sent messages for unsend:', dbErr.message);
          }
        }

        if (userData && userData.messages.length > 0) {
          for (const m of userData.messages) {
            if (!messagesToDelete.some(sm => sm.id === m.id)) {
              messagesToDelete.push(m);
            }
          }
          userData.messages = []; // Clear local list immediately to prevent double-deletes
        }
        broadcastQueues();

        if (messagesToDelete.length > 0) {
          await interaction.reply({
            content: '🧹 Deleting spam messages to clean traces...',
            flags: MessageFlags.Ephemeral
          });

          const deletePromises = messagesToDelete.map(async (item) => {
            try {
              if (item.webhook) {
                await item.webhook.deleteMessage(item.id);
              } else {
                const channel = await client.channels.fetch(item.channelId);
                const fetchedMsg = await channel.messages.fetch(item.id);
                await fetchedMsg.delete();
              }
              if (databaseUrl) {
                await pool.query('DELETE FROM sent_messages WHERE id = $1', [item.id]).catch(() => {});
              }
              return true;
            } catch (err) {
              if (err.code === 10008 || err.message.includes('Unknown Message') || err.message.includes('Not Found')) {
                if (databaseUrl) {
                  await pool.query('DELETE FROM sent_messages WHERE id = $1', [item.id]).catch(() => {});
                }
                return true;
              }
              console.error(`[Unsend Error] Failed to delete message ${item.id}:`, err.message);
              return false;
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
        let allMessages = [];
        if (databaseUrl) {
          try {
            const dbRes = await pool.query('SELECT id, user_id, channel_id, webhook_id, webhook_token, interaction_token FROM sent_messages');
            allMessages = dbRes.rows.map(sm => ({
              id: sm.id,
              userId: sm.user_id,
              channelId: sm.channel_id,
              webhook: sm.webhook_id ? {
                deleteMessage: async (msgId) => {
                  const wh = new WebhookClient({ id: sm.webhook_id, token: sm.webhook_token });
                  return wh.deleteMessage(msgId);
                }
              } : (sm.interaction_token ? {
                deleteMessage: async (msgId) => {
                  const wh = new WebhookClient({ id: clientId, token: sm.interaction_token });
                  return wh.deleteMessage(msgId);
                }
              } : null)
            }));
          } catch (dbErr) {
            console.error('[Database] Failed to fetch sent messages for unsendall:', dbErr.message);
          }
        }

        userSpams.forEach((userData, userId) => {
          if (userData.messages.length > 0) {
            for (const m of userData.messages) {
              if (!allMessages.some(sm => sm.id === m.id)) {
                allMessages.push({ ...m, userId });
              }
            }
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
              if (item.webhook) {
                await item.webhook.deleteMessage(item.id);
              } else {
                const channel = await client.channels.fetch(item.channelId);
                const fetchedMsg = await channel.messages.fetch(item.id);
                await fetchedMsg.delete();
              }
              if (databaseUrl) {
                await pool.query('DELETE FROM sent_messages WHERE id = $1', [item.id]).catch(() => {});
              }
              return true;
            } catch (err) {
              if (err.code === 10008 || err.message.includes('Unknown Message') || err.message.includes('Not Found')) {
                if (databaseUrl) {
                  await pool.query('DELETE FROM sent_messages WHERE id = $1', [item.id]).catch(() => {});
                }
                return true;
              }
              console.error(`[Unsendall Error] Failed to delete message ${item.id}:`, err.message);
              return false;
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
              'SELECT message_text, spam_count, delay_ms, use_tts, use_embed, self_destruct_seconds, ghost_spam, panda_raid, embed_title, embed_image_url, embed_color FROM spam_sessions WHERE session_id = $1',
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
        const ghostSpam = session.ghost_spam || false;
        const pandaRaid = session.panda_raid || false;
        const embedTitle = session.embed_title || null;
        const embedImageUrl = session.embed_image_url || null;
        const embedColor = session.embed_color || null;

        // Initialize user entry if not exists
        if (!userSpams.has(userId)) {
          userSpams.set(userId, { queue: [], sending: false, messages: [], username: interaction.user.tag || interaction.user.username });
        }
        const userData = userSpams.get(userId);
        userData.username = interaction.user.tag || interaction.user.username;
        userData.currentMessage = pandaRaid ? '🐼 Panda Raid Active!' : messageText;

        // Acknowledge the interaction immediately to prevent timeout silently
        await interaction.deferUpdate();

        // Log the spam initiation if database is configured (avoiding duplicates within 3 minutes)
        if (databaseUrl) {
          try {
            const checkLog = await pool.query(
              `SELECT id FROM spam_logs 
               WHERE user_id = $1 AND channel_id = $2 AND message_text = $3 
               AND initiated_at > NOW() - INTERVAL '3 minutes'
               ORDER BY initiated_at DESC LIMIT 1`,
              [userId, interaction.channelId || null, (pandaRaid ? '🐼 Panda Raid' : messageText).slice(0, 200)]
            );

            if (checkLog.rowCount > 0) {
              const logId = checkLog.rows[0].id;
              await pool.query(
                'UPDATE spam_logs SET click_count = click_count + 1, initiated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [logId]
              );
            } else {
              const guildName = interaction.guild ? interaction.guild.name : null;
              await pool.query(
                'INSERT INTO spam_logs (user_id, username, guild_id, guild_name, channel_id, message_text, click_count) VALUES ($1, $2, $3, $4, $5, $6, 1)',
                [
                  userId,
                  interaction.user.tag || interaction.user.username,
                  interaction.guildId || null,
                  guildName,
                  interaction.channelId || null,
                  (pandaRaid ? '🐼 Panda Raid' : messageText).slice(0, 200)
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

        // Add customizable messages to the queue (persisted to database if configured)
        const sessionItems = [];
        if (databaseUrl) {
          try {
            for (let i = 0; i < count; i++) {
              const insertRes = await pool.query(
                `INSERT INTO active_queues (
                  user_id, username, guild_id, channel_id, message_text, delay_ms, use_tts, use_embed, 
                  self_destruct_seconds, ghost_spam, panda_raid, embed_title, embed_image_url, embed_color, interaction_token
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
                [
                  userId, userData.username, interaction.guildId || null, interaction.channelId || null, messageText || '', delay, tts, embed,
                  selfDestruct, ghostSpam, pandaRaid, embedTitle || null, embedImageUrl || null, embedColor || null, interaction.token
                ]
              );
              sessionItems.push({
                dbQueueId: insertRes.rows[0].id,
                messageText,
                interaction,
                tts,
                embed,
                delay,
                selfDestruct,
                ghostSpam,
                pandaRaid,
                embedTitle,
                embedImageUrl,
                embedColor,
                itemIndex: i
              });
            }
          } catch (dbErr) {
            console.error('[Database] Failed to save active queue items:', dbErr.message);
          }
        }

        if (sessionItems.length === 0) {
          for (let i = 0; i < count; i++) {
            sessionItems.push({
              messageText,
              interaction,
              tts,
              embed,
              delay,
              selfDestruct,
              ghostSpam,
              pandaRaid,
              embedTitle,
              embedImageUrl,
              embedColor,
              itemIndex: i
            });
          }
        }

        userData.queue.push(...sessionItems);
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
