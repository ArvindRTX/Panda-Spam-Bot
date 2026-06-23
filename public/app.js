// Global State
let adminPassword = localStorage.getItem('panda_admin_pass') || '';
let sseSource = null;
let allLogs = []; // Cache all logs for client-side search filtering
let trendChart = null;
let channelsChart = null;
let usersChart = null;

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const adminPassInput = document.getElementById('admin-pass');
const loginError = document.getElementById('login-error');
const oauthContainer = document.getElementById('oauth-container');
const discordLoginBtn = document.getElementById('discord-login-btn');

const appContainer = document.getElementById('app-container');
const logoutBtn = document.getElementById('logout-btn');
const connectionStatus = document.getElementById('connection-status');
const themeSelect = document.getElementById('theme-select');

// Metrics elements
const botStatusEl = document.getElementById('bot-status');
const botUptimeEl = document.getElementById('bot-uptime');
const botLatencyEl = document.getElementById('bot-latency');
const botGuildsEl = document.getElementById('bot-guilds');
const totalLogsEl = document.getElementById('total-logs');
const authUsersCountEl = document.getElementById('auth-users-count');

// Users elements
const addUserForm = document.getElementById('add-user-form');
const newUserIdInput = document.getElementById('new-user-id');
const actionFeedback = document.getElementById('action-feedback');
const usersLoading = document.getElementById('users-loading');
const usersListContainer = document.getElementById('users-list-container');

// Logs elements
const refreshLogsBtn = document.getElementById('refresh-logs-btn');
const logsLoading = document.getElementById('logs-loading');
const logsListContainer = document.getElementById('logs-list-container');
const logSearchInput = document.getElementById('log-search-input');
const logLocationFilter = document.getElementById('log-location-filter');
const logDateFilter = document.getElementById('log-date-filter');
const exportLogsBtn = document.getElementById('export-logs-btn');

// Active Queues elements
const activeQueuesList = document.getElementById('active-queues-list-container');
const activeQueuesCount = document.getElementById('active-queues-count');

// Diagnostics elements
const diagnosticsListContainer = document.getElementById('diagnostics-list-container');
const diagnosticsCount = document.getElementById('diagnostics-count');

// Web Spammer Console elements
const webSpamForm = document.getElementById('web-spam-form');
const spamEmbedCheckbox = document.getElementById('spam-embed');
const embedOptionsPanel = document.getElementById('embed-options-panel');
const consoleFeedback = document.getElementById('console-feedback');

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Theme
  const savedTheme = localStorage.getItem('panda_theme') || 'default';
  document.body.setAttribute('data-theme', savedTheme);
  themeSelect.value = savedTheme;
  themeSelect.addEventListener('change', handleThemeChange);

  // Check URL Query Parameters for OAuth Redirects
  const urlParams = new URLSearchParams(window.location.search);
  const tokenParam = urlParams.get('token');
  const errorParam = urlParams.get('error');

  if (tokenParam) {
    adminPassword = tokenParam;
    localStorage.setItem('panda_admin_pass', tokenParam);
    // Strip query parameters
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (errorParam) {
    loginError.textContent = `OAuth Error: ${decodeURIComponent(errorParam)}`;
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Load configuration and check OAuth Status
  checkConfig();

  if (adminPassword) {
    verifyAuthentication(adminPassword);
  }

  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  addUserForm.addEventListener('submit', handleAuthorizeUser);
  refreshLogsBtn.addEventListener('click', () => loadLogs(true));
  logSearchInput.addEventListener('input', filterAndRenderLogs);
  logLocationFilter.addEventListener('change', filterAndRenderLogs);
  logDateFilter.addEventListener('change', filterAndRenderLogs);
  exportLogsBtn.addEventListener('click', exportLogsToCSV);

  // Collapsible Embed Options in Web Console
  spamEmbedCheckbox.addEventListener('change', () => {
    if (spamEmbedCheckbox.checked) {
      embedOptionsPanel.classList.remove('hidden');
    } else {
      embedOptionsPanel.classList.add('hidden');
    }
  });

  // Web Spammer Console form submission
  webSpamForm.addEventListener('submit', handleWebSpamSubmit);

  // Tabs navigation wiring
  setupTabs();
});

// Helper for HTTP requests
async function fetchAPI(endpoint, options = {}) {
  const url = `${window.location.origin}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(adminPassword ? { 'Authorization': `Bearer ${adminPassword}` } : {}),
    ...options.headers
  };
  
  const response = await fetch(url, { ...options, headers });
  
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error('Unauthorized');
  }
  
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'API Error occurred');
  }
  return data;
}

// Authentication Logic
async function verifyAuthentication(password) {
  try {
    const res = await fetch(`${window.location.origin}/api/verify-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    
    if (res.ok) {
      adminPassword = password;
      localStorage.setItem('panda_admin_pass', password);
      
      loginOverlay.classList.add('hidden');
      appContainer.classList.remove('hidden');
      setConnectionStatus(true, 'Connected');
      
      // Initialize Dashboard data & SSE stream connection
      initDashboard();
    } else {
      localStorage.removeItem('panda_admin_pass');
      loginError.textContent = 'Invalid credentials. Access Denied.';
    }
  } catch (err) {
    loginError.textContent = 'Server connection failed.';
    console.error('Auth error:', err);
  }
}

function handleLogin(e) {
  e.preventDefault();
  const password = adminPassInput.value.trim();
  if (password) {
    verifyAuthentication(password);
  }
}

function handleLogout() {
  localStorage.removeItem('panda_admin_pass');
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  destroyCharts();
  window.location.reload();
}

function handleUnauthorized() {
  localStorage.removeItem('panda_admin_pass');
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  destroyCharts();
  appContainer.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
  loginError.textContent = 'Session expired. Please log in again.';
}

function setConnectionStatus(connected, text) {
  if (connected) {
    connectionStatus.className = 'status-indicator online';
    connectionStatus.querySelector('.status-text').textContent = text;
  } else {
    connectionStatus.className = 'status-indicator offline';
    connectionStatus.querySelector('.status-text').textContent = text;
  }
}

// Dashboard Data Fetching & Real-time Sync
function initDashboard() {
  // Load users once initially
  loadUsers();
  
  // Close any existing EventSource
  if (sseSource) {
    sseSource.close();
  }
  
  // Establish connection to Server-Sent Events
  setConnectionStatus(false, 'Connecting...');
  sseSource = new EventSource(`/api/events?token=${encodeURIComponent(adminPassword)}`);
  
  // Handle stats updates
  sseSource.addEventListener('stats', (event) => {
    try {
      const stats = JSON.parse(event.data);
      updateStatusUI(stats);
      setConnectionStatus(true, 'Live Sync');
    } catch (err) {
      console.error('[SSE] Failed to parse stats event:', err);
    }
  });

  // Handle logs updates
  sseSource.addEventListener('logs', (event) => {
    try {
      const logs = JSON.parse(event.data);
      allLogs = logs;
      filterAndRenderLogs();
    } catch (err) {
      console.error('[SSE] Failed to parse logs event:', err);
    }
  });

  // Handle active queues updates
  sseSource.addEventListener('queues', (event) => {
    try {
      const queues = JSON.parse(event.data);
      renderActiveQueues(queues);
    } catch (err) {
      console.error('[SSE] Failed to parse queues event:', err);
    }
  });

  // Handle analytics updates
  sseSource.addEventListener('analytics', (event) => {
    try {
      const analytics = JSON.parse(event.data);
      updateCharts(analytics);
    } catch (err) {
      console.error('[SSE] Failed to parse analytics event:', err);
    }
  });

  // Handle diagnostics updates
  sseSource.addEventListener('diagnostics', (event) => {
    try {
      const errors = JSON.parse(event.data);
      renderDiagnostics(errors);
    } catch (err) {
      console.error('[SSE] Failed to parse diagnostics event:', err);
    }
  });

  sseSource.onerror = (err) => {
    console.error('[SSE] EventSource connection error:', err);
    setConnectionStatus(false, 'Reconnecting...');
  };
}

// Update Status Metrics UI
function updateStatusUI(data) {
  botStatusEl.textContent = data.status;
  botStatusEl.className = 'metric-val ' + (data.status === 'Online' ? 'color-green' : 'color-pink');
  
  botUptimeEl.textContent = formatUptime(data.uptime);
  botLatencyEl.textContent = `${data.latency} ms`;
  botGuildsEl.textContent = data.guilds;
  totalLogsEl.textContent = data.totalLogs;
  authUsersCountEl.textContent = `${data.authorizedCount} Users`;
  
  // Save owner id globally for access list badge check
  window.botOwnerId = data.ownerId;
}

// Manual Status Loader (fallback)
async function loadStatus() {
  try {
    const data = await fetchAPI('/api/status');
    updateStatusUI(data);
    setConnectionStatus(true, 'Live Sync');
  } catch (error) {
    console.error('Status fetch failed:', error);
    setConnectionStatus(false, 'Disconnected');
  }
}

// Load Authorized Users
async function loadUsers() {
  try {
    usersLoading.classList.remove('hidden');
    usersListContainer.classList.add('hidden');
    
    const data = await fetchAPI('/api/users');
    usersListContainer.innerHTML = '';
    
    if (data.users.length === 0) {
      usersListContainer.innerHTML = '<div class="spinner-container"><span>No authorized users found.</span></div>';
    } else {
      data.users.forEach(user => {
        const isOwner = window.botOwnerId && user.user_id === window.botOwnerId;
        const row = document.createElement('div');
        row.className = 'user-row';
        
        const details = document.createElement('div');
        details.className = 'user-details';
        
        const title = document.createElement('div');
        title.className = 'user-tag';
        const displayLabel = user.username ? escapeHTML(user.username) : `User ID: ${user.user_id}`;
        title.innerHTML = `<i class="fa-solid fa-user-shield" style="color: var(--accent-violet);"></i> ${displayLabel}`;
        
        if (isOwner) {
          title.innerHTML += ' <span class="owner-badge">Owner</span>';
        }
        
        const meta = document.createElement('div');
        meta.className = 'user-meta';
        const date = new Date(user.added_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const idText = user.username ? `ID: ${user.user_id} | ` : '';
        meta.textContent = `${idText}Added by ${user.added_by} on ${date} IST`;
        
        details.appendChild(title);
        details.appendChild(meta);
        row.appendChild(details);
        
        if (!isOwner && data.source === 'database') {
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btn-icon-delete';
          deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
          deleteBtn.onclick = () => handleDeauthorizeUser(user.user_id);
          row.appendChild(deleteBtn);
        }
        
        usersListContainer.appendChild(row);
      });
    }
    
    usersLoading.classList.add('hidden');
    usersListContainer.classList.remove('hidden');
  } catch (error) {
    console.error('Users fetch failed:', error);
  }
}

// Manual/Fallback Logs Loader
async function loadLogs(manual = false) {
  try {
    if (manual) {
      logsLoading.classList.remove('hidden');
      logsListContainer.classList.add('hidden');
    }
    
    const data = await fetchAPI('/api/logs');
    allLogs = data.logs;
    filterAndRenderLogs();
    
    logsLoading.classList.add('hidden');
    logsListContainer.classList.remove('hidden');
  } catch (error) {
    console.error('Logs fetch failed:', error);
  }
}

// Search logs and render filtered results
function filterAndRenderLogs() {
  const query = logSearchInput.value.trim().toLowerCase();
  const location = logLocationFilter.value;
  const dateVal = logDateFilter.value;

  const filtered = allLogs.filter(log => {
    const username = (log.username || '').toLowerCase();
    const userId = (log.user_id || '').toLowerCase();
    const guildId = (log.guild_id || 'dm').toLowerCase();
    const channelId = (log.channel_id || 'dm').toLowerCase();
    const text = (log.message_text || '').toLowerCase();
    
    const textMatch = !query || 
                      username.includes(query) ||
                      userId.includes(query) ||
                      guildId.includes(query) ||
                      channelId.includes(query) ||
                      text.includes(query);

    let locMatch = true;
    if (location === 'guild') {
      locMatch = !!log.guild_id;
    } else if (location === 'dm') {
      locMatch = !log.guild_id;
    }

    let dateMatch = true;
    if (dateVal) {
      const logDateStr = new Date(log.initiated_at).toISOString().split('T')[0];
      dateMatch = logDateStr === dateVal;
    }

    return textMatch && locMatch && dateMatch;
  });

  renderLogs(filtered);
  window.filteredLogsCache = filtered;
}

// Render dynamic log rows
function renderLogs(logs) {
  logsLoading.classList.add('hidden');
  logsListContainer.classList.remove('hidden');
  
  logsListContainer.innerHTML = '';
  
  if (logs.length === 0) {
    logsListContainer.innerHTML = '<div class="spinner-container"><span>No matching audit logs found.</span></div>';
    return;
  }
  
  logs.forEach(log => {
    const row = document.createElement('div');
    row.className = 'log-row';
    
    const metaTop = document.createElement('div');
    metaTop.className = 'log-meta-top';
    
    const userSpan = document.createElement('span');
    userSpan.className = 'log-user';
    userSpan.innerHTML = `<i class="fa-solid fa-user-ninja" style="color: var(--accent-pink); margin-right: 6px;"></i><span style="color: var(--accent-pink); font-weight:700;">${escapeHTML(log.username || 'Unknown')}</span> (\`${log.user_id}\`)`;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = new Date(log.initiated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    
    metaTop.appendChild(userSpan);
    metaTop.appendChild(timeSpan);
    
    const body = document.createElement('div');
    body.className = 'log-body';
    body.textContent = log.message_text;
    
    const metaBottom = document.createElement('div');
    metaBottom.className = 'log-meta-bottom';
    
    const serverSpan = document.createElement('span');
    const serverText = log.guild_name ? `Guild: <strong>${escapeHTML(log.guild_name)}</strong>` : (log.guild_id ? `Guild ID: <code>${log.guild_id}</code>` : 'Location: <strong>DM</strong>');
    serverSpan.innerHTML = `<i class="fa-solid fa-network-wired"></i> ${serverText}`;
    
    const channelSpan = document.createElement('span');
    channelSpan.innerHTML = `<i class="fa-solid fa-hashtag"></i> Channel ID: <code>${log.channel_id || 'DM'}</code>`;

    const clicksSpan = document.createElement('span');
    const clickCount = log.click_count || 1;
    clicksSpan.innerHTML = `<i class="fa-solid fa-arrow-pointer"></i> Clicks: <strong style="color: var(--accent-cyan);">${clickCount}</strong>`;
    
    metaBottom.appendChild(serverSpan);
    metaBottom.appendChild(channelSpan);
    metaBottom.appendChild(clicksSpan);
    
    row.appendChild(metaTop);
    row.appendChild(body);
    row.appendChild(metaBottom);
    
    logsListContainer.appendChild(row);
  });
}

// Render active spam sessions
function renderActiveQueues(queues) {
  activeQueuesCount.textContent = `${queues.length} Active`;
  activeQueuesList.innerHTML = '';

  if (queues.length === 0) {
    activeQueuesList.innerHTML = '<div class="empty-placeholder">No active spam sequences running.</div>';
    return;
  }

  queues.forEach(queue => {
    const row = document.createElement('div');
    row.className = 'queue-row';

    const details = document.createElement('div');
    details.className = 'queue-details';

    const userSpan = document.createElement('div');
    userSpan.className = 'queue-user';
    userSpan.innerHTML = `<i class="fa-solid fa-user-ninja" style="color: var(--accent-pink);"></i> ${escapeHTML(queue.username)} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(${queue.userId})</span>`;

    const msgSpan = document.createElement('div');
    msgSpan.className = 'queue-msg';
    msgSpan.textContent = queue.currentMessage || 'No active message';

    const badgeContainer = document.createElement('div');
    badgeContainer.className = 'queue-badge-container';

    const badge = document.createElement('span');
    badge.className = `queue-badge ${queue.sending ? 'sending' : 'pending'}`;
    badge.textContent = queue.sending ? 'Sending' : 'Queued';

    const lenBadge = document.createElement('span');
    lenBadge.className = 'badge';
    lenBadge.textContent = `${queue.queueLength} remaining`;

    badgeContainer.appendChild(badge);
    badgeContainer.appendChild(lenBadge);

    details.appendChild(userSpan);
    details.appendChild(msgSpan);
    details.appendChild(badgeContainer);
    row.appendChild(details);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'queue-actions';

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-queue btn-queue-stop';
    stopBtn.innerHTML = '<i class="fa-solid fa-hand"></i> Stop';
    stopBtn.onclick = () => handleStopQueue(queue.userId);

    const purgeBtn = document.createElement('button');
    purgeBtn.className = 'btn-queue btn-queue-purge';
    purgeBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Purge';
    purgeBtn.onclick = () => handlePurgeQueue(queue.userId);

    actions.appendChild(stopBtn);
    actions.appendChild(purgeBtn);
    row.appendChild(actions);

    activeQueuesList.appendChild(row);
  });
}

// Chart.js Initializer & Theme Customization
function initCharts() {
  const chartFontFamily = "'Outfit', sans-serif";
  const textMuted = '#9ca3af';
  const gridLineColor = 'rgba(255, 255, 255, 0.05)';

  // 1. Trend Chart
  const trendCtx = document.getElementById('trend-chart').getContext('2d');
  
  const trendGradient = trendCtx.createLinearGradient(0, 0, 0, 200);
  trendGradient.addColorStop(0, 'rgba(0, 242, 254, 0.35)');
  trendGradient.addColorStop(1, 'rgba(0, 242, 254, 0)');

  trendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`),
      datasets: [{
        label: 'Spam Messages',
        data: Array(24).fill(0),
        borderColor: '#00f2fe',
        borderWidth: 2,
        backgroundColor: trendGradient,
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#00f2fe',
        pointBorderColor: '#ffffff',
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 43, 0.9)',
          titleFont: { family: chartFontFamily, weight: 'bold', size: 12 },
          bodyFont: { family: chartFontFamily, size: 12 },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: false
        }
      },
      scales: {
        x: {
          grid: { color: gridLineColor },
          ticks: { color: textMuted, font: { family: chartFontFamily, size: 9 } }
        },
        y: {
          grid: { color: gridLineColor },
          ticks: { color: textMuted, font: { family: chartFontFamily, size: 9 }, precision: 0 },
          min: 0
        }
      }
    }
  });

  // 2. Channels Chart
  const channelsCtx = document.getElementById('channels-chart').getContext('2d');
  channelsChart = new Chart(channelsCtx, {
    type: 'doughnut',
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: [
          '#ec4899', // pink
          '#8b5cf6', // violet
          '#00f2fe', // cyan
          '#f59e0b', // yellow
          '#10b981'  // green
        ],
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: textMuted,
            font: { family: chartFontFamily, size: 9 },
            boxWidth: 10
          }
        },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 43, 0.9)',
          titleFont: { family: chartFontFamily, weight: 'bold', size: 12 },
          bodyFont: { family: chartFontFamily, size: 12 },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10
        }
      },
      cutout: '65%'
    }
  });

  // 3. Users Chart
  const usersCtx = document.getElementById('users-chart').getContext('2d');
  usersChart = new Chart(usersCtx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Spam Triggers',
        data: [],
        backgroundColor: 'rgba(139, 92, 246, 0.75)',
        borderColor: '#8b5cf6',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13, 18, 43, 0.9)',
          titleFont: { family: chartFontFamily, weight: 'bold', size: 12 },
          bodyFont: { family: chartFontFamily, size: 12 },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10,
          displayColors: false
        }
      },
      scales: {
        x: {
          grid: { color: gridLineColor },
          ticks: { color: textMuted, font: { family: chartFontFamily, size: 9 }, precision: 0 },
          min: 0
        },
        y: {
          grid: { display: false },
          ticks: { color: textMuted, font: { family: chartFontFamily, size: 9 } }
        }
      }
    }
  });
}

// Redraw chart elements smoothly with transitions
function updateCharts(data) {
  if (!trendChart || !channelsChart || !usersChart) {
    initCharts();
  }

  // 1. Update Trend
  if (data.trend && data.trend.length > 0) {
    trendChart.data.labels = data.trend.map(d => d.label);
    trendChart.data.datasets[0].data = data.trend.map(d => d.count);
    trendChart.update();
  }

  // 2. Update Channels
  if (data.channels) {
    channelsChart.data.labels = data.channels.map(d => d.label);
    channelsChart.data.datasets[0].data = data.channels.map(d => d.count);
    channelsChart.update();
  }

  // 3. Update Users
  if (data.users) {
    usersChart.data.labels = data.users.map(d => d.label);
    usersChart.data.datasets[0].data = data.users.map(d => d.count);
    usersChart.update();
  }
}

// Destroy charts on de-auth or logout to prevent Canvas recycling errors
function destroyCharts() {
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (channelsChart) { channelsChart.destroy(); channelsChart = null; }
  if (usersChart) { usersChart.destroy(); usersChart = null; }
}

// User Actions
async function handleAuthorizeUser(e) {
  e.preventDefault();
  const userId = newUserIdInput.value.trim();
  
  if (!/^\d{17,20}$/.test(userId)) {
    showFeedback('Invalid User ID (should be 17-20 digit number)', false);
    return;
  }
  
  try {
    const data = await fetchAPI('/api/users/authorize', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
    
    showFeedback(data.message, true);
    newUserIdInput.value = '';
    loadUsers();
  } catch (err) {
    showFeedback(err.message, false);
  }
}

async function handleDeauthorizeUser(userId) {
  if (!confirm(`Are you sure you want to deauthorize user ID: ${userId}?`)) {
    return;
  }
  
  try {
    const data = await fetchAPI('/api/users/deauthorize', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
    
    showFeedback(data.message, true);
    loadUsers();
  } catch (err) {
    showFeedback(err.message, false);
  }
}

async function handleStopQueue(userId) {
  try {
    const data = await fetchAPI('/api/active-queues/stop', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
    showFeedback(data.message, true);
  } catch (err) {
    showFeedback(err.message, false);
  }
}

async function handlePurgeQueue(userId) {
  if (!confirm(`Are you sure you want to stop and delete all sent messages for user ${userId}?`)) {
    return;
  }
  try {
    const data = await fetchAPI('/api/active-queues/purge', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
    showFeedback(data.message, true);
  } catch (err) {
    showFeedback(err.message, false);
  }
}

// Utility Functions
function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600*24));
  const h = Math.floor((seconds % (3600*24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function showFeedback(text, success) {
  actionFeedback.className = 'action-feedback ' + (success ? 'feedback-success' : 'feedback-error');
  actionFeedback.textContent = text;
  
  setTimeout(() => {
    actionFeedback.textContent = '';
  }, 4000);
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Render Error Diagnostics
function renderDiagnostics(errors) {
  diagnosticsCount.textContent = `${errors.length} Errors`;
  diagnosticsListContainer.innerHTML = '';

  if (errors.length === 0) {
    diagnosticsListContainer.innerHTML = '<div class="empty-placeholder">No errors logged. All systems nominal! 🐼</div>';
    return;
  }

  errors.forEach(err => {
    const row = document.createElement('div');
    row.className = 'error-log-row';

    const header = document.createElement('div');
    header.className = 'error-log-header';
    
    const codeSpan = document.createElement('span');
    codeSpan.style.fontWeight = 'bold';
    codeSpan.style.color = 'var(--accent-red)';
    codeSpan.textContent = err.error_code ? `Error Code: ${err.error_code}` : 'API Error';
    
    const timeSpan = document.createElement('span');
    timeSpan.style.fontSize = '0.75rem';
    timeSpan.style.color = 'var(--text-muted)';
    timeSpan.textContent = new Date(err.timestamp || err.initiated_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    
    header.appendChild(codeSpan);
    header.appendChild(timeSpan);

    const msg = document.createElement('div');
    msg.className = 'error-log-msg';
    msg.textContent = err.error_message;

    const meta = document.createElement('div');
    meta.className = 'error-log-meta';
    
    const locText = [];
    if (err.user_id) locText.push(`User: ${err.user_id}`);
    if (err.channel_id) locText.push(`Channel: ${err.channel_id}`);
    if (err.guild_id) locText.push(`Guild: ${err.guild_id}`);
    meta.textContent = locText.join(' | ') || 'System Event';

    row.appendChild(header);
    row.appendChild(msg);
    row.appendChild(meta);
    diagnosticsListContainer.appendChild(row);
  });
}

// Theme Switcher handler
function handleThemeChange(e) {
  const theme = e.target.value;
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('panda_theme', theme);
}

// Web Spammer Console execution trigger
async function handleWebSpamSubmit(e) {
  e.preventDefault();
  
  const channelId = document.getElementById('spam-channel-id').value.trim();
  const delay = parseInt(document.getElementById('spam-delay').value, 10) || 100;
  const messageText = document.getElementById('spam-text').value;
  
  const embed = document.getElementById('spam-embed').checked;
  const tts = document.getElementById('spam-tts').checked;
  const ghostSpam = document.getElementById('spam-ghost').checked;
  const pandaRaid = document.getElementById('spam-panda-raid').checked;
  
  const embedTitle = document.getElementById('spam-embed-title').value.trim();
  const embedColor = document.getElementById('spam-embed-color').value;
  const embedImageUrl = document.getElementById('spam-embed-image').value.trim();
  
  const selfDestruct = parseInt(document.getElementById('spam-self-destruct').value, 10) || 0;

  showConsoleFeedback('Initiating spam command...', true);

  try {
    const data = await fetchAPI('/api/spam/trigger', {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        messageText,
        delay,
        tts,
        embed,
        selfDestruct,
        ghostSpam,
        pandaRaid,
        embedTitle,
        embedImageUrl,
        embedColor
      })
    });
    
    showConsoleFeedback(data.message, true);
    document.getElementById('spam-text').value = '';
  } catch (err) {
    showConsoleFeedback(err.message, false);
  }
}

function showConsoleFeedback(text, success) {
  consoleFeedback.className = 'action-feedback ' + (success ? 'feedback-success' : 'feedback-error');
  consoleFeedback.textContent = text;
  setTimeout(() => {
    consoleFeedback.textContent = '';
  }, 4000);
}

// Setup operations vs settings tabs switching
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetTab = btn.getAttribute('data-tab');
      tabPanels.forEach(p => {
        if (p.id === targetTab) {
          p.classList.remove('hidden');
        } else {
          p.classList.add('hidden');
        }
      });
    });
  });
}

// Convert logs to CSV format and prompt download
function exportLogsToCSV() {
  const logsToExport = window.filteredLogsCache || allLogs;
  if (!logsToExport || logsToExport.length === 0) {
    alert('No audit logs available to export.');
    return;
  }

  const headers = ['Timestamp (IST)', 'User Tag', 'User ID', 'Location', 'Guild/Channel IDs', 'Clicks Count', 'Message Text'];
  
  const rows = logsToExport.map(log => {
    const timeStr = new Date(log.initiated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const loc = log.guild_name ? 'Guild Server' : (log.guild_id ? 'Guild Server' : 'DM');
    const ids = log.guild_id ? `Server: ${log.guild_id} | Channel: ${log.channel_id}` : `DM Channel: ${log.channel_id || 'N/A'}`;
    const cleanText = (log.message_text || '').replace(/"/g, '""');

    return [
      `"${timeStr}"`,
      `"${log.username || 'Unknown'}"`,
      `"${log.user_id}"`,
      `"${loc}"`,
      `"${ids}"`,
      log.click_count || 1,
      `"${cleanText}"`
    ];
  });

  const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `panda_spam_logs_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Fetch bot configurations (like OAuth parameters state)
async function checkConfig() {
  try {
    const res = await fetch(`${window.location.origin}/api/config`);
    const data = await res.json();
    if (data.oauthEnabled) {
      oauthContainer.classList.remove('hidden');
      
      discordLoginBtn.addEventListener('click', async () => {
        try {
          const authUrlRes = await fetch(`${window.location.origin}/api/auth/url`);
          const authUrlData = await authUrlRes.json();
          if (authUrlData.url) {
            window.location.href = authUrlData.url;
          } else {
            console.error('Failed to get authorize URL:', authUrlData.error);
          }
        } catch (err) {
          console.error('Error fetching authorize URL:', err);
        }
      });
    }
  } catch (err) {
    console.warn('[Config] Failed to fetch server config state:', err.message);
  }
}
