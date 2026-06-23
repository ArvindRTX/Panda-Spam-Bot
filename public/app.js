// Global State
let adminPassword = localStorage.getItem('panda_admin_pass') || '';
let statsPollInterval = null;
let logsPollInterval = null;

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const adminPassInput = document.getElementById('admin-pass');
const loginError = document.getElementById('login-error');

const appContainer = document.getElementById('app-container');
const logoutBtn = document.getElementById('logout-btn');
const connectionStatus = document.getElementById('connection-status');

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

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
  if (adminPassword) {
    verifyAuthentication(adminPassword);
  }

  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  addUserForm.addEventListener('submit', handleAuthorizeUser);
  refreshLogsBtn.addEventListener('click', () => loadLogs(true));
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
      
      // Initialize Dashboard data
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
  window.location.reload();
}

function handleUnauthorized() {
  localStorage.removeItem('panda_admin_pass');
  clearInterval(statsPollInterval);
  clearInterval(logsPollInterval);
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

// Dashboard Data Fetching & Polling
function initDashboard() {
  loadStatus();
  loadUsers();
  loadLogs();
  
  // Setup Polling intervals (every 10 seconds)
  clearInterval(statsPollInterval);
  statsPollInterval = setInterval(loadStatus, 10000);
  
  clearInterval(logsPollInterval);
  logsPollInterval = setInterval(loadLogs, 10000);
}

// Load System Status Metrics
async function loadStatus() {
  try {
    const data = await fetchAPI('/api/status');
    
    botStatusEl.textContent = data.status;
    botStatusEl.className = 'metric-val ' + (data.status === 'Online' ? 'color-green' : 'color-pink');
    
    botUptimeEl.textContent = formatUptime(data.uptime);
    botLatencyEl.textContent = `${data.latency} ms`;
    botGuildsEl.textContent = data.guilds;
    totalLogsEl.textContent = data.totalLogs;
    authUsersCountEl.textContent = `${data.authorizedCount} Users`;
    
    // Save owner id globally for access list badge check
    window.botOwnerId = data.ownerId;
    
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

// Load Spam Audit Logs
async function loadLogs(manual = false) {
  try {
    if (manual) {
      logsLoading.classList.remove('hidden');
      logsListContainer.classList.add('hidden');
    }
    
    const data = await fetchAPI('/api/logs');
    logsListContainer.innerHTML = '';
    
    if (data.logs.length === 0) {
      logsListContainer.innerHTML = '<div class="spinner-container"><span>No audit logs recorded yet.</span></div>';
    } else {
      data.logs.forEach(log => {
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
        serverSpan.innerHTML = `<i class="fa-solid fa-network-wired"></i> Guild ID: <code>${log.guild_id || 'DM'}</code>`;
        
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
    
    logsLoading.classList.add('hidden');
    logsListContainer.classList.remove('hidden');
  } catch (error) {
    console.error('Logs fetch failed:', error);
  }
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
    loadStatus();
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
    loadStatus();
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
