/**
RDP Ultra Bot v6.2 - Production Grade
Developed by AlkshwlyHacker | 2026
v6.2: HTML escaping (root-cause), image fallback via @napi-rs/canvas,
      single-fire shutdown, PID single-instance, Discord EDIT-not-resend
*/
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
// ═══════════════════════════════════════════════════════
//  🗂️ UNIFIED SYSTEM LOGGER
// ═══════════════════════════════════════════════════════
const LOG_DIR = 'C:\logs';
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
const Logger = {
  _write(level, msg, data = null) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    if (level === 'ERROR') console.error(line.trim());
    else console.log(line.trim());
  },
  info(msg, data)    { this._write('INFO',    msg, data); },
  warn(msg, data)    { this._write('WARN',    msg, data); },
  error(msg, data)   { this._write('ERROR',   msg, data); },
  success(msg, data) { this._write('SUCCESS', msg, data); }
};
// ═══════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════
const BOT_TOKEN        = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID       = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_URL      = process.env.DISCORD_WEBHOOK_URL;
const LOCK_FILE        = 'C:\session_active.lock';
const PID_FILE         = 'C:\Users\Public\bot.pid';
const BACKUP_SCRIPT    = 'C:\Users\Public\backup.ps1';
const TG_SESSION_FILE  = 'C:\Users\Public\tg_session.dat';
const TG_PANEL_FILE    = 'C:\Users\Public\tg_panel.dat';
const TS_STATUS_FILE   = 'C:\Users\Public\tailscale_status.json';
const TS_EXE           = 'C:\Program Files\Tailscale\tailscale.exe';
const TELEGRAM_API_ID  = parseInt(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH    = process.env.TELEGRAM_API_HASH;
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL     = process.env.TELEGRAM_CHANNEL_ID;
const TAILSCALE_AUTHKEY    = process.env.TAILSCALE_AUTHKEY;
const WORKFLOW_START       = Date.now();
const WORKFLOW_TIMEOUT     = 360 * 60 * 1000;
const ALERT_THRESHOLDS     = [10 * 60 * 1000, 5 * 60 * 1000, 1 * 60 * 1000];
const firedAlerts          = new Set();
if (!BOT_TOKEN || !CHANNEL_ID) {
  Logger.error('FATAL: Missing Discord credentials');
  process.exit(1);
}
// ═══════════════════════════════════════════════════════
//  v6.2 SINGLE-INSTANCE GUARD (PID)
// ═══════════════════════════════════════════════════════
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (_) {}
      if (alive) {
        try { execSync('taskkill /PID ' + oldPid + ' /T /F', { stdio: 'ignore' }); } catch (_) {}
        Logger.warn('Killed stale bot instance', { pid: oldPid });
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (_) {}
// ═══════════════════════════════════════════════════════
//  STATE MANAGEMENT
// ═══════════════════════════════════════════════════════
let state = 'IDLE', currentProc = null, currentPhase = 'IDLE';
let saveCount = 0, lastResult = 'None';
let controlChannel = null, lastStatusMsg = null, logLines = [];
let tgClient = null, tgEntity = null, tailscaleIp = 'N/A';
let statusPending = false, tgPanelMsg = null;
let lastTgPanelUpdate = 0, lastTgPanelState = '';
let webhookDead = false, shuttingDown = false;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function maskSecrets(text) {
  return String(text)
    .replace(/--authkey=\S+/g, '--authkey=***')
    .replace(/tskey-[A-Za-z0-9-]+/g, 'tskey-***')
    .replace(/API key \S+/g, 'API key ***')
    .replace(/ts[A-Za-z0-9_-]{20,}/g, 'MASKED');
}
// ═══════════════════════════════════════════════════════
//  v6.2 HTML SAFETY + IMAGE FALLBACK
// ═══════════════════════════════════════════════════════
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function mdToHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch (_) {
  Logger.warn('canvas lib unavailable — image fallback disabled');
}
function wrapLine(line, max) {
  if (line.length <= max) return [line];
  const out = [];
  let cur = '';
  for (const part of line.split(' ')) {
    if ((cur + ' ' + part).trim().length > max) { out.push(cur.trim()); cur = part; }
    else cur += ' ' + part;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function textToImageBuffer(text) {
  if (!canvasLib) return null;
  try {
    const lines = [];
    String(text).split('\n').forEach(l => lines.push(...wrapLine(l, 72)));
    const fontSize = 30, lineH = 46, pad = 50;
    const width = 1400;
    const height = pad * 2 + lines.length * lineH;
    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e1621';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.font = fontSize + 'px "Segoe UI", "Consolas", sans-serif';
    ctx.textBaseline = 'top';
    let y = pad;
    for (const l of lines) { ctx.fillText(l, pad, y); y += lineH; }
    const buf = canvas.toBuffer('image/png');
    buf.name = 'rdp_message.png';
    return buf;
  } catch (e) {
    Logger.warn('Image render failed', { msg: e.message });
    return null;
  }
}
// ═══════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════
function sendDiscordWebhook(content) {
  if (!WEBHOOK_URL || webhookDead) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ content: maskSecrets(content) });
      const url = new URL(WEBHOOK_URL);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf8')
        }
      };
      const proto = url.protocol === 'https:' ? https : http;
      const req = proto.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 404) {
            webhookDead = true;
            Logger.warn('Webhook dead (404) — disabling further calls');
            resolve(false);
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            Logger.success('Discord webhook sent');
            resolve(true);
          } else {
            Logger.warn('Discord webhook failed', { status: res.statusCode });
            resolve(false);
          }
        });
      });
      req.on('error', e => { Logger.error('Webhook error', { msg: e.message }); resolve(false); });
      req.write(body);
      req.end();
    } catch (e) {
      Logger.error('Webhook exception', { msg: e.message });
      resolve(false);
    }
  });
}
function getTailscaleStatus() {
  let fullJson = '', textStatus = '', ip = null, backendState = 'Unknown', authUrl = null;
  try {
    fullJson = execSync('"' + TS_EXE + '" status --json', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const st = JSON.parse(fullJson);
    backendState = st.BackendState || 'Unknown';
    authUrl = st.AuthURL || null;
    if (st.Self && st.Self.TailscaleIPs && st.Self.TailscaleIPs.length > 0) ip = st.Self.TailscaleIPs[0];
  } catch (e) { Logger.warn('Tailscale JSON parse failed', { msg: e.message }); }
  try { textStatus = execSync('"' + TS_EXE + '" status', { encoding: 'utf8' }); } catch (_) { textStatus = ''; }
  return { fullJson, textStatus, ip, backendState, authUrl };
}
function captureTailscaleStatus() {
  const { fullJson } = getTailscaleStatus();
  if (fullJson) {
    try { fs.writeFileSync(TS_STATUS_FILE, fullJson.trim(), 'utf8'); return true; }
    catch (e) { Logger.error('Write TS status failed', { msg: e.message }); }
  }
  return false;
}
async function sendStatusFileToBoth() {
  if (!fs.existsSync(TS_STATUS_FILE)) return;
  if (tgClient && tgEntity) {
    try {
      await tgClient.sendFile(tgEntity, { file: TS_STATUS_FILE, forceDocument: true, fileName: 'tailscale_status.json' });
      Logger.success('TS JSON sent to Telegram');
    } catch (e) { Logger.warn('TG JSON failed', { msg: e.message }); }
  }
  if (controlChannel) {
    try {
      const file = new AttachmentBuilder(TS_STATUS_FILE, { name: 'tailscale_status.json' });
      await controlChannel.send({ files: [file] });
      Logger.success('TS JSON sent to Discord');
    } catch (e) { Logger.warn('Discord JSON failed', { msg: e.message }); }
  }
  updatePanel();
}
// ═══════════════════════════════════════════════════════
//  TELEGRAM CONNECTION
// ═══════════════════════════════════════════════════════
async function initTelegramConnection() {
  const delays = [3000, 5000, 8000, 12000, 20000];
  for (let i = 0; i < 5; i++) {
    try {
      let sd = '';
      try { if (fs.existsSync(TG_SESSION_FILE)) sd = fs.readFileSync(TG_SESSION_FILE, 'utf8').trim(); } catch (_) {}
      const inst = new TelegramClient(new StringSession(sd), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });
      await inst.start({ botAuthToken: TELEGRAM_BOT_TOKEN });
      try { const s = inst.session.save(); if (s && s.length > 10) fs.writeFileSync(TG_SESSION_FILE, s, 'utf8'); } catch (_) {}
      Logger.success('Telegram connected successfully');
      return inst;
    } catch (err) {
      Logger.warn('TG attempt ' + (i + 1) + ' failed', { msg: err.errorMessage || err.message });
      if (i < 4) await sleep(delays[i]);
    }
  }
  Logger.error('Telegram connection failed after 5 attempts');
  return null;
}
async function resolveChannelEntity(inst) {
  if (!TELEGRAM_CHANNEL) return null;
  try { return await inst.getEntity(TELEGRAM_CHANNEL); } catch (_) {}
  if (/^\d+$/.test(TELEGRAM_CHANNEL)) {
    try { return await inst.getEntity('-100' + TELEGRAM_CHANNEL); } catch (_) {}
  }
  Logger.warn('Telegram entity resolution failed');
  return null;
}
// v6.2: محاولة HTML مهرب → عند فشل parsing تُرسل الرسالة كصورة → ثم نص خام
async function sendTelegramMsg(htmlText, maxRetries, plainText) {
  if (!tgClient || !tgEntity) return false;
  for (let i = 0; i < (maxRetries || 3); i++) {
    try {
      if (!tgClient.connected) await tgClient.connect();
      await tgClient.sendMessage(tgEntity, { message: htmlText, parseMode: 'html', linkPreview: false });
      return true;
    } catch (err) {
      const m = err.errorMessage || err.message || '';
      if (m.includes('FLOOD_WAIT')) {
        await sleep(parseInt((m.match(/\d+/) || ['30'])[0]) * 1000);
        continue;
      }
      if (/parse|entit|HTML/i.test(m)) break;
      if (i < 2) await sleep([2000, 4000][i] || 2000);
    }
  }
  if (plainText) {
    const buf = textToImageBuffer(plainText.replace(/\*\*/g, '').replace(/`/g, ''));
    if (buf) {
      try {
        await tgClient.sendFile(tgEntity, { file: buf, forceDocument: false });
        Logger.success('Telegram message delivered as image');
        return true;
      } catch (e) { Logger.warn('Image fallback failed', { msg: e.message }); }
    }
    try {
      await tgClient.sendMessage(tgEntity, { message: plainText, linkPreview: false });
      return true;
    } catch (_) {}
  }
  return false;
}
function persistPanelId(id) {
  try { fs.writeFileSync(TG_PANEL_FILE, String(id), 'utf8'); } catch (_) {}
}
function loadPanelId() {
  try {
    if (fs.existsSync(TG_PANEL_FILE)) {
      const id = parseInt(fs.readFileSync(TG_PANEL_FILE, 'utf8').trim(), 10);
      if (!isNaN(id)) return id;
    }
  } catch (_) {}
  return null;
}
// ═══════════════════════════════════════════════════════
//  CONNECTION MESSAGE
// ═══════════════════════════════════════════════════════
async function sendConnectionMessage(sessionInfo) {
  const info = sessionInfo || {};
  const ip          = info.tailscaleIp     || tailscaleIp || 'N/A';
  const publicIp    = info.publicIp        || 'N/A';
  const rdpUser     = info.rdpUser         || 'TOOLBOXLAP';
  const rdpPassword = info.rdpPassword     || '(check RDP_PASSWORD secret)';
  const hostname    = info.hostname        || 'unknown';
  const status      = info.tailscaleStatus || 'Unknown';
  const authUrl     = info.authUrl         || null;
  const time        = info.startTime       || new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  let msg;
  if (status === 'NeedsLogin' || ip === 'N/A') {
    if (authUrl) {
      msg = '⚠️ **Tailscale Requires Authentication**\n━━━━━━━━━━━━━━━━━━━━━\n' +
            '🔗 **Auth URL:** ' + authUrl + '\n' +
            '🖥️ **Hostname:** ' + hostname + '\n' +
            '🌐 **Public IP:** ' + publicIp + '\n' +
            '👤 **RDP User:** ' + rdpUser + '\n' +
            '🔑 **Password:** ' + rdpPassword + '\n' +
            '📡 **Status:** ' + status + '\n' +
            '🕐 **Time:** ' + time + '\n' +
            '━━━━━━━━━━━━━━━━━━━━━\n' +
            '👉 **Open the Auth URL above to authenticate**';
    } else {
      msg = '❌ **Tailscale Auth Failed**\n━━━━━━━━━━━━━━━━━━━━━\n' +
            '🖥️ **Hostname:** ' + hostname + '\n' +
            '🌐 **Public IP:** ' + publicIp + '\n' +
            '👤 **RDP User:** ' + rdpUser + '\n' +
            '🔑 **Password:** ' + rdpPassword + '\n' +
            '📡 **Status:** ' + status + '\n' +
            '🕐 **Time:** ' + time + '\n' +
            '━━━━━━━━━━━━━━━━━━━━━\n' +
            '⚠️ **Fix:** Check TAILSCALE_AUTHKEY secret';
    }
  } else {
    msg = '🖥️ **RDP SESSION READY**\n━━━━━━━━━━━━━━━━━━━━━\n' +
          '🔗 **Tailscale IP:** ' + ip + '\n' +
          '🖥️ **Hostname:** ' + hostname + '\n' +
          '🌐 **Public IP:** ' + publicIp + '\n' +
          '👤 **RDP User:** ' + rdpUser + '\n' +
          '🔑 **Password:** ' + rdpPassword + '\n' +
          '🔌 **RDP Port:** 3389\n' +
          '📡 **Status:** ' + status + '\n' +
          '🕐 **Time:** ' + time + '\n' +
          '━━━━━━━━━━━━━━━━━━━━━\n' +
          '👉 Connect via: `mstsc /v:' + ip + '`';
  }
  let discordOk = false;
  if (WEBHOOK_URL && !webhookDead) {
    discordOk = await sendDiscordWebhook(msg);
    if (discordOk) Logger.success('Connection msg -> Discord webhook');
  }
  if (!discordOk && controlChannel) {
    try {
      await controlChannel.send({ content: msg });
      Logger.success('Connection msg -> Discord bot');
      discordOk = true;
    } catch (e) { Logger.warn('Discord bot msg failed', { msg: e.message }); }
  }
  let tgOk = false;
  if (tgClient && tgEntity) {
    tgOk = await sendTelegramMsg(mdToHtml(msg), 3, msg);
    if (tgOk) Logger.success('Connection msg -> Telegram');
  }
  return discordOk || tgOk;
}
// ═══════════════════════════════════════════════════════
//  UNIFIED COMMAND HANDLER
// ═══════════════════════════════════════════════════════
async function handleCommand(cmd, source, interaction = null) {
  const c = cmd.trim().toLowerCase();
  let response = '';
  try {
    if (c === '!' || c === '!c' || c === '!cancel') {
      await killAll();
      response = '🛑 Operation cancelled';
    } else if (c === '!save' || c === '!start') {
      runBackup();
      response = '💾 Backup started';
    } else if (c === '!restart' || c === '!rts') {
      await restartTailscale();
      response = '🔄 Tailscale restart initiated';
    } else if (c === '!json') {
      captureTailscaleStatus();
      await sendStatusFileToBoth();
      response = '📎 JSON file sent';
    } else if (c === '!conn') {
      await sendConnectionMessage();
      response = '📨 Connection message re-sent';
    } else if (c === '!clean') {
      cleanupTempFiles();
      response = '🧹 Temp files cleaned';
    } else if (c === '!status') {
      const remaining = Math.max(0, 360 - Math.floor((Date.now() - WORKFLOW_START) / 60000));
      response = '**State:** ' + state + '\n**Phase:** ' + currentPhase +
                 '\n**Saves:** ' + saveCount + '\n**Remaining:** ' + remaining +
                 ' min\n**Last:** ' + maskSecrets(lastResult);
    } else if (c === '!log') {
      if (source === 'discord' && interaction) {
        try {
          const attachment = new AttachmentBuilder(LOG_FILE, { name: 'bot.log' });
          await interaction.followUp({ files: [attachment], ephemeral: true });
          response = '📋 Log file sent';
        } catch (e) {
          Logger.error('Failed to send log file', { msg: e.message });
          response = '❌ Failed to send log';
        }
      } else if (source === 'telegram') {
        try {
          if (tgClient && tgEntity) {
            await tgClient.sendFile(tgEntity, { file: LOG_FILE, forceDocument: true, fileName: 'bot.log' });
            response = '📋 Log file sent to Telegram';
          }
        } catch (e) {
          Logger.error('TG log send failed', { msg: e.message });
          response = '❌ Failed to send log to TG';
        }
      } else if (source === 'discord' && controlChannel) {
        try {
          const attachment = new AttachmentBuilder(LOG_FILE, { name: 'bot.log' });
          await controlChannel.send({ files: [attachment] });
          response = '📋 Log file sent';
        } catch (e) {
          response = '❌ Failed to send log';
        }
      }
    } else if (c === '!help') {
      response = '**Available Commands:**\n`!save` - Start backup\n`!cancel` - Cancel operation\n' +
                 '`!restart` - Restart Tailscale\n`!json` - Send Tailscale JSON\n' +
                 '`!conn` - Re-send connection message\n`!clean` - Clean temp files\n' +
                 '`!status` - Show current status\n`!log` - Send bot log file\n`!help` - Show this help';
    } else {
      response = '❓ Unknown command. Type `!help` for available commands.';
    }
  } catch (err) {
    Logger.error('Command error', { cmd: c, msg: err.message });
    response = '❌ Command error: ' + maskSecrets(err.message).substring(0, 100);
  }
  if (source === 'discord' && interaction) {
    try { await interaction.followUp({ content: response, ephemeral: true }); } catch (_) {}
  } else if (source === 'discord' && controlChannel) {
    try { await controlChannel.send(response); } catch (_) {}
  } else if (source === 'telegram') {
    await sendTelegramMsg(mdToHtml(response), 2, response);
  }
  return response;
}
// ═══════════════════════════════════════════════════════
//  TELEGRAM INITIALIZATION
// ═══════════════════════════════════════════════════════
async function initializeTelegramAndNotify() {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL) {
    Logger.warn('Telegram credentials missing');
    return;
  }
  Logger.info('Connecting to Telegram...');
  updatePanel();
  tgClient = await initTelegramConnection();
  if (!tgClient) { lastResult = '❌ TG connection failed'; updatePanel(); return; }
  tgEntity = await resolveChannelEntity(tgClient);
  if (!tgEntity) { lastResult = '❌ TG entity not found'; updatePanel(); return; }
  registerTelegramHandlers();
  const pid = loadPanelId();
  if (pid) tgPanelMsg = { id: pid };
  let sessionInfo = null;
  try {
    const infoPath = 'C:\\Users\\Public\\session_info.json';
    if (fs.existsSync(infoPath)) {
      sessionInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      if (sessionInfo.tailscaleIp) tailscaleIp = sessionInfo.tailscaleIp;
    }
  } catch (e) { Logger.warn('Session info parse failed', { msg: e.message }); }
  const sent = await sendConnectionMessage(sessionInfo);
  lastResult = sent ? '✅ Connection msg sent' : '❌ Connection msg failed';
  updatePanel();
  captureTailscaleStatus();
  await sendStatusFileToBoth();
  await sendTelegramPanel(true);
}
// ═══════════════════════════════════════════════════════
//  TELEGRAM PANEL
// ═══════════════════════════════════════════════════════
async function sendTelegramPanel(force) {
  if (!tgClient || !tgEntity) return;
  const now = Date.now();
  if (!force && tgPanelMsg && state === 'IDLE' && lastTgPanelState === 'IDLE' && (now - lastTgPanelUpdate) < 60000) return;
  try {
    const remaining = Math.max(0, 360 - Math.floor((Date.now() - WORKFLOW_START) / 60000));
    const text = '🖥️ <b>RDP Ultra Station Control</b>\n' +
      '📊 <b>Status:</b> ' + escapeHtml(state) + '\n' +
      '⏱️ <b>Remaining:</b> ' + remaining + ' min\n' +
      '💾 <b>Saves:</b> ' + saveCount + '\n' +
      '🔗 <b>TS IP:</b> <code>' + escapeHtml(tailscaleIp) + '</code>';
    const buttons = [
      [{ text: '💾 Save',       callback_data: 'btn_save'       }, { text: '🛑 Cancel',  callback_data: 'btn_cancel'   }],
      [{ text: '🔄 Restart TS', callback_data: 'btn_restart_ts' }, { text: '📊 Status',  callback_data: 'btn_status'   }],
      [{ text: '📎 JSON',       callback_data: 'btn_json'       }, { text: '📨 Re-send', callback_data: 'btn_conn'     }],
      [{ text: '📋 Log',        callback_data: 'btn_log'        }, { text: '🧹 Clean',   callback_data: 'btn_clean'    }]
    ];
    if (tgPanelMsg) {
      try {
        await tgClient.editMessage(tgEntity, tgPanelMsg.id, { text, buttons, parseMode: 'html' });
      } catch (editErr) {
        const em = editErr.errorMessage || editErr.message || '';
        if (!em.includes('MESSAGE_NOT_MODIFIED')) {
          tgPanelMsg = await tgClient.sendMessage(tgEntity, { message: text, buttons, parseMode: 'html', linkPreview: false });
          persistPanelId(tgPanelMsg.id);
        }
      }
    } else {
      tgPanelMsg = await tgClient.sendMessage(tgEntity, { message: text, buttons, parseMode: 'html', linkPreview: false });
      persistPanelId(tgPanelMsg.id);
    }
    lastTgPanelUpdate = Date.now();
    lastTgPanelState = state;
    Logger.info('Telegram panel updated');
  } catch (err) {
    Logger.error('TG panel error', { msg: err.message });
  }
}
async function handleTelegramCallback(callbackData) {
  try {
    switch (callbackData) {
      case 'btn_save':
        runBackup();
        await sendTelegramMsg('💾 Backup started', 2);
        break;
      case 'btn_cancel':
        await killAll();
        await sendTelegramMsg('🛑 Cancelled', 2);
        break;
      case 'btn_restart_ts':
        await restartTailscale();
        await sendTelegramMsg('🔄 Restart initiated', 2);
        break;
      case 'btn_status': {
        const remaining = Math.max(0, 360 - Math.floor((Date.now() - WORKFLOW_START) / 60000));
        await sendTelegramMsg(
          '📊 <b>Status:</b> ' + escapeHtml(state) + '\n⏱️ <b>Remaining:</b> ' + remaining +
          ' min\n💾 <b>Saves:</b> ' + saveCount + '\n📝 <b>Last:</b> ' + escapeHtml(maskSecrets(lastResult)),
          2
        );
        break;
      }
      case 'btn_json':
        captureTailscaleStatus();
        await sendStatusFileToBoth();
        await sendTelegramMsg('📎 JSON sent', 2);
        break;
      case 'btn_conn':
        await sendConnectionMessage();
        await sendTelegramMsg('📨 Connection message re-sent', 2);
        break;
      case 'btn_clean':
        cleanupTempFiles();
        await sendTelegramMsg('🧹 Temp files cleaned', 2);
        break;
      case 'btn_log':
        try {
          if (tgClient && tgEntity) {
            await tgClient.sendFile(tgEntity, { file: LOG_FILE, forceDocument: true, fileName: 'bot.log' });
            await sendTelegramMsg('📋 Log file sent', 2);
          }
        } catch (e) {
          await sendTelegramMsg('❌ Failed to send log', 2);
        }
        break;
    }
    await sendTelegramPanel(true);
  } catch (err) {
    Logger.error('TG callback error', { data: callbackData, msg: err.message });
    await sendTelegramMsg('❌ Error: ' + escapeHtml(maskSecrets(err.message).substring(0, 80)), 2);
  }
}
// ═══════════════════════════════════════════════════════
//  DISCORD EMBED & PANEL (v6.2: EDIT instead of send+delete)
// ═══════════════════════════════════════════════════════
function addLog(line) {
  Logger.info(line);
  const ts = new Date().toLocaleTimeString();
  logLines.push('`' + ts + '` ' + maskSecrets(line));
  if (logLines.length > 8) logLines = logLines.slice(-8);
}
function buildEmbed() {
  const colors = { IDLE: 0x99AAB5, COMPRESSING: 0xFFA500, UPLOADING: 0x3498DB, CANCELLING: 0xE74C3C, RESTARTING: 0x9B59B6 };
  const logText = logLines.length > 0 ? logLines.join('\n') : 'No activity yet';
  const remaining = Math.max(0, 360 - Math.floor((Date.now() - WORKFLOW_START) / 60000));
  return new EmbedBuilder()
    .setTitle('🖥️ RDP Ultra Station Control')
    .setColor(colors[state] || 0x99AAB5)
    .addFields(
      { name: 'Status',    value: state,                                inline: true  },
      { name: 'Phase',     value: currentPhase,                         inline: true  },
      { name: 'Saves',     value: String(saveCount),                    inline: true  },
      { name: 'Remaining', value: remaining + ' min',                   inline: true  },
      { name: 'TS IP',     value: '`' + tailscaleIp + '`',              inline: true  },
      { name: 'TG',        value: (tgClient && tgEntity) ? '✅' : '❌',  inline: true  },
      { name: 'Last',      value: maskSecrets(lastResult),              inline: false },
      { name: 'Log',       value: logText,                              inline: false }
    )
    .setTimestamp();
}
function buildButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_save').setLabel('Save').setEmoji('💾').setStyle(ButtonStyle.Primary).setDisabled(state !== 'IDLE'),
      new ButtonBuilder().setCustomId('btn_cancel').setLabel('Cancel').setEmoji('🛑').setStyle(ButtonStyle.Danger).setDisabled(state === 'IDLE' || state === 'CANCELLING'),
      new ButtonBuilder().setCustomId('btn_restart_ts').setLabel('Restart TS').setEmoji('🔄').setStyle(ButtonStyle.Secondary).setDisabled(state !== 'IDLE'),
      new ButtonBuilder().setCustomId('btn_status').setLabel('Status').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('btn_log').setLabel('Log').setEmoji('📋').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_clean').setLabel('Clean').setEmoji('🧹').setStyle(ButtonStyle.Secondary)
    )
  ];
}
async function postStatus() {
  if (!controlChannel) return;
  const payload = { embeds: [buildEmbed()], components: buildButtons() };
  try {
    if (lastStatusMsg) {
      try { await lastStatusMsg.edit(payload); return; }
      catch (_) { lastStatusMsg = null; }
    }
    lastStatusMsg = await controlChannel.send(payload);
  } catch (e) { Logger.warn('Post status failed', { msg: e.message }); }
}
function updatePanel() {
  if (statusPending) return Promise.resolve();
  statusPending = true;
  setTimeout(function () {
    statusPending = false;
    postStatus().catch(function () {});
    sendTelegramPanel().catch(function () {});
  }, 2500);
  return Promise.resolve();
}
// ═══════════════════════════════════════════════════════
//  CORE OPERATIONS
// ═══════════════════════════════════════════════════════
function killProcessTree(pid) {
  try { execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' }); Logger.info('Process killed', { pid }); }
  catch (e) { Logger.warn('Kill process failed', { pid, msg: e.message }); }
}
function cleanupTempFiles() {
  try {
    const t = process.env.TEMP || process.env.TMP;
    const o = path.join(t, 'backup_output'), w = path.join(t, 'backup_work');
    if (fs.existsSync(o)) fs.readdirSync(o).forEach(f => { try { fs.unlinkSync(path.join(o, f)); } catch (_) {} });
    if (fs.existsSync(w)) fs.rmSync(w, { recursive: true, force: true });
    Logger.info('Temp files cleaned');
  } catch (e) { Logger.warn('Cleanup failed', { msg: e.message }); }
}
async function restartTailscale() {
  if (state !== 'IDLE') { lastResult = '⚠️ Busy'; updatePanel(); return; }
  state = 'RESTARTING'; currentPhase = 'Restarting TS';
  addLog('🔄 Restart initiated'); updatePanel();
  try {
    try { execSync('"' + TS_EXE + '" down', { stdio: 'ignore', timeout: 30000 }); } catch (_) {}
    await sleep(2000);
    let ok = false;
    const runNum = process.env.RUN_NUMBER || '1';
    try {
      execSync('"' + TS_EXE + '" up --hostname=rdp-alkshwly-' + runNum + ' --accept-routes', { stdio: 'ignore', timeout: 60000 });
      ok = true;
    } catch (e1) {
      Logger.warn('TS up without authkey failed', { msg: e1.message });
      if (TAILSCALE_AUTHKEY) {
        try {
          execSync('"' + TS_EXE + '" up --authkey=' + TAILSCALE_AUTHKEY +
            ' --hostname=rdp-alkshwly-' + runNum + ' --accept-routes --reset',
            { stdio: 'ignore', timeout: 60000 });
          ok = true;
        } catch (_) {}
      }
    }
    if (!ok) throw new Error('Reconnect failed');
    let newIp = null;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      try {
        const s = JSON.parse(execSync('"' + TS_EXE + '" status --json', { encoding: 'utf8' }));
        if (s.Self && s.Self.TailscaleIPs && s.Self.TailscaleIPs[0]) { newIp = s.Self.TailscaleIPs[0]; break; }
      } catch (_) {}
    }
    if (newIp) {
      tailscaleIp = newIp;
      lastResult = '✅ IP: ' + newIp;
      await sendConnectionMessage({ tailscaleIp: newIp, tailscaleStatus: 'Restarted', hostname: 'rdp-alkshwly-' + runNum });
      captureTailscaleStatus();
      await sendStatusFileToBoth();
      Logger.success('Tailscale restarted', { ip: newIp });
    } else {
      lastResult = '⚠️ IP pending';
    }
  } catch (err) {
    lastResult = '❌ ' + maskSecrets(err.message).substring(0, 80);
    Logger.error('TS restart failed', { msg: err.message });
  }
  state = 'IDLE'; currentPhase = 'IDLE'; updatePanel();
}
async function killAll() {
  if (state === 'IDLE') { lastResult = 'No op'; updatePanel(); return; }
  if (state === 'CANCELLING') return;
  state = 'CANCELLING'; updatePanel();
  if (currentProc && currentProc.pid) killProcessTree(currentProc.pid);
  cleanupTempFiles();
  currentProc = null; currentPhase = 'IDLE'; state = 'IDLE';
  lastResult = '🛑 Cancelled'; updatePanel();
  Logger.info('Operation cancelled by user');
}
function pipeLog(proc) {
  if (proc.stdout) proc.stdout.on('data', d => {
    String(d).split('\n').filter(l => l.trim()).forEach(l => { addLog(l.trim().substring(0, 80)); updatePanel(); });
  });
  if (proc.stderr) proc.stderr.on('data', d => {
    String(d).split('\n').filter(l => l.trim()).forEach(l => { addLog('⚠️ ' + l.trim().substring(0, 77)); updatePanel(); });
  });
}
function runBackup() {
  if (state !== 'IDLE') return;
  state = 'COMPRESSING'; currentPhase = 'Compressing';
  addLog('🗜️ Backup started'); updatePanel();
  Logger.info('Backup operation started');
  const proc = spawn('pwsh', ['-ExecutionPolicy', 'Bypass', '-File', BACKUP_SCRIPT], { stdio: 'pipe', windowsHide: true });
  currentProc = proc;
  pipeLog(proc);
  const to = setTimeout(function () {
    if (currentProc === proc && state === 'COMPRESSING') {
      killProcessTree(proc.pid);
      state = 'IDLE'; currentPhase = 'IDLE'; lastResult = '❌ Timeout';
      Logger.error('Backup timeout');
      updatePanel();
    }
  }, 600000);
  proc.on('close', async function (code) {
    clearTimeout(to);
    if (code !== 0) {
      state = 'IDLE'; currentPhase = 'IDLE';
      lastResult = '❌ Exit ' + code;
      Logger.error('Backup failed', { code });
      updatePanel();
      return;
    }
    const mPath = path.join(process.env.TEMP || process.env.TMP, 'backup_output', 'backup_manifest.json');
    let files = [];
    if (fs.existsSync(mPath)) {
      try { const m = JSON.parse(fs.readFileSync(mPath, 'utf8')); if (m.Success && m.Files) files = m.Files; }
      catch (e) { Logger.warn('Manifest parse failed', { msg: e.message }); }
    }
    if (files.length === 0) {
      state = 'IDLE'; currentPhase = 'IDLE';
      Logger.info('Backup completed - no files');
      lastResult = '⚠️ No matched folders';
      updatePanel();
      return;
    }
    const names = [...new Set(files.map(f => f.Folder))].join(', ');
    addLog('📦 Matched: ' + names);
    sendTelegramMsg('📦 <b>Matched folders:</b> <code>' + escapeHtml(names) + '</code>', 1, '📦 Matched: ' + names).catch(function () {});
    state = 'UPLOADING'; currentPhase = 'Uploading';
    addLog('☁️ Upload started'); updatePanel();
    Logger.info('Upload started', { fileCount: files.length });
    let up = 0, fa = 0;
    for (const f of files) {
      if (state === 'CANCELLING') break;
      if (!fs.existsSync(f.Path)) { fa++; continue; }
      let ok = false;
      for (let a = 1; a <= 3 && !ok; a++) {
        try {
          if (!tgClient || !tgEntity) throw new Error('No TG');
          if (!tgClient.connected) await tgClient.connect();
          await tgClient.sendFile(tgEntity, {
            file: f.Path, caption: 'Backup: ' + f.Folder + '\nFile: ' + f.Name,
            forceDocument: true, fileName: f.Name, workers: 4
          });
          up++; ok = true;
          try { fs.unlinkSync(f.Path); } catch (_) {}
        } catch (err) {
          const m = err.errorMessage || err.message || '';
          if (m.includes('FLOOD_WAIT')) await sleep(parseInt((m.match(/\d+/) || ['30'])[0]) * 1000);
          else await sleep(a * 3000);
        }
      }
      if (!ok) fa++;
    }
    currentProc = null; currentPhase = 'IDLE'; state = 'IDLE';
    if (up > 0) {
      saveCount++;
      lastResult = '✅ Backup #' + saveCount + ' (' + up + '/' + (up + fa) + ')';
      Logger.success('Backup completed', { success: up, failed: fa, total: saveCount });
    } else {
      lastResult = '❌ All uploads failed';
      Logger.error('All uploads failed', { total: files.length });
    }
    updatePanel();
  });
}
// ═══════════════════════════════════════════════════════
//  TIMEOUT ALERTS & DISCORD INTERACTIONS
// ═══════════════════════════════════════════════════════
async function checkTimeoutAlerts() {
  const remaining = WORKFLOW_TIMEOUT - (Date.now() - WORKFLOW_START);
  for (const t of ALERT_THRESHOLDS) {
    if (remaining <= t && !firedAlerts.has(t)) {
      firedAlerts.add(t);
      const mins = Math.round(t / 60000);
      Logger.warn('Timeout alert', { mins });
      await sendTelegramMsg('⏰ <b>TIMEOUT WARNING</b>\n' + mins + ' min remaining', 2, 'TIMEOUT WARNING - ' + mins + ' min remaining');
      if (WEBHOOK_URL && !webhookDead) await sendDiscordWebhook('⏰ TIMEOUT WARNING - ' + mins + ' min remaining');
      else if (controlChannel) controlChannel.send('⏰ ' + mins + ' min left').catch(function () {});
    }
  }
}
client.once('ready', async function () {
  Logger.success('Discord client ready', { guilds: client.guilds.cache.size });
  try {
    controlChannel = await client.channels.fetch(CHANNEL_ID);
    lastStatusMsg = await controlChannel.send({ embeds: [buildEmbed()], components: buildButtons() });
    Logger.success('Control channel initialized', { id: CHANNEL_ID });
  } catch (e) {
    Logger.error('Control channel init failed', { msg: e.message });
  }
  await initializeTelegramAndNotify();
  setInterval(function () { checkTimeoutAlerts().catch(function () {}); }, 30000);
  setInterval(function () { postStatus().catch(function () {}); sendTelegramPanel().catch(function () {}); }, 30000);
});
client.on('interactionCreate', async function (i) {
  if (!i.isButton()) return;
  try {
    await i.deferUpdate();
    Logger.info('Button pressed', { id: i.customId, user: i.user.tag });
    switch (i.customId) {
      case 'btn_save':
        runBackup();
        await i.followUp({ content: '💾 Backup started', ephemeral: true });
        break;
      case 'btn_cancel':
        await killAll();
        await i.followUp({ content: '🛑 Cancelled', ephemeral: true });
        break;
      case 'btn_restart_ts':
        await restartTailscale();
        await i.followUp({ content: '🔄 Restart initiated', ephemeral: true });
        break;
      case 'btn_status': {
        const remaining = Math.max(0, 360 - Math.floor((Date.now() - WORKFLOW_START) / 60000));
        const statusText = '**State:** ' + state + '\n**Phase:** ' + currentPhase +
          '\n**Saves:** ' + saveCount + '\n**Remaining:** ' + remaining +
          ' min\n**Last:** ' + maskSecrets(lastResult);
        await i.followUp({ content: statusText, ephemeral: true });
        break;
      }
      case 'btn_clean':
        cleanupTempFiles();
        await i.followUp({ content: '🧹 Temp files cleaned', ephemeral: true });
        break;
      case 'btn_log': {
        try {
          const attachment = new AttachmentBuilder(LOG_FILE, { name: 'bot.log' });
          await i.followUp({ files: [attachment], ephemeral: true });
        } catch (e) {
          await i.followUp({ content: '❌ Failed to send log', ephemeral: true });
        }
        break;
      }
    }
  } catch (err) {
    Logger.error('Button interaction error', { id: i.customId, msg: err.message });
  }
});
client.on('messageCreate', async function (msg) {
  if (msg.author.bot || msg.channelId !== CHANNEL_ID) return;
  try {
    if (msg.content.trim().toLowerCase().startsWith('!')) {
      await msg.react('✅');
      await handleCommand(msg.content, 'discord', msg);
    }
  } catch (err) {
    Logger.error('Message handler error', { msg: err.message });
  }
});
function registerTelegramHandlers() {
  if (!tgClient) return;
  tgClient.addEventHandler(async (update) => {
    try {
      if (update.message && update.message.message) {
        const text = update.message.message;
        if (text.startsWith('!')) await handleCommand(text, 'telegram');
      }
    } catch (err) {
      Logger.error('TG update error', { msg: err.message });
    }
  }, new Api.UpdateNewMessage({}));
  tgClient.addEventHandler(async (update) => {
    try {
      if (update.callbackQuery) {
        const data = update.callbackQuery.data.toString();
        await handleTelegramCallback(data);
        try { await tgClient.answerCallbackQuery(update.callbackQuery.queryId, { message: 'Done' }); } catch (_) {}
      }
    } catch (err) {
      Logger.error('TG callback error', { msg: err.message });
    }
  }, new Api.UpdateCallbackQuery({}));
  Logger.success('Telegram handlers registered');
}
// ═══════════════════════════════════════════════════════
//  v6.2 GUARDED SHUTDOWN (single-fire)
// ═══════════════════════════════════════════════════════
process.on('unhandledRejection', e => Logger.error('Unhandled rejection', { msg: e.message || e }));
process.on('uncaughtException',  e => Logger.error('Uncaught exception', { msg: e.message, stack: e.stack }));
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  Logger.info('Shutdown initiated', { reason });
  if (currentProc && currentProc.pid) killProcessTree(currentProc.pid);
  await Promise.race([
    sendTelegramMsg('🛑 <b>Bot stopped</b> (' + escapeHtml(reason) + ')', 1),
    sleep(4000)
  ]);
  try { client.destroy(); } catch (_) {}
  if (tgClient) try { await tgClient.disconnect(); } catch (_) {}
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
setInterval(() => { if (!shuttingDown && !fs.existsSync(LOCK_FILE)) shutdown('Lock removed'); }, 5000);
client.login(BOT_TOKEN).catch(e => {
  Logger.error('Discord login failed', { msg: e.message });
  process.exit(1);
});
