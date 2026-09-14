require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const pino    = require('pino');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth directory ──
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

// ── NxT AI Configuration ──
const NXT_API_KEY = 'nxt_2c624b598de74d58aa318ad7914f74a5'; 
// আপনার NxT AI এর GEM ID (Shahriar বোটের ID নিচে দেওয়া হলো)
const GEM_ID      = '9a189417-74bd-4a01-9712-cd3762d9a76d'; 

// ── State ──
let logs          = ['🚀 RIYAD PERSONAL AI starting up...'];
let pairingCode   = null;
let waConnected   = false;
let waSocket      = null;
let waStarting    = false;
let waPhoneNumber = null;
let reconnectAttempts = 0;

function pushLog(msg) {
    const ts = new Date().toLocaleTimeString('bn-BD');
    logs.push(`[${ts}] ${msg}`);
    if (logs.length > 200) logs = logs.slice(-200);
    console.log(msg);
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Detect image generation requests ──
function extractImagePrompt(text) {
    const trimmed = text.trim();
    const cmdMatch = trimmed.match(/^\/(image|img|imagine)\s+(.+)/i);
    if (cmdMatch) return cmdMatch[2].trim();
    const patterns = [
        /^(?:একটা |একটি )?(.+?)(?:\s*-?এর)?\s*(?:ছবি|পিকচার|পিক)\s*(?:বানাও|তৈরি কর|দাও|দে|generate|বানা)/i,
        /^(?:draw|generate|make|create)\s+(?:an?\s+)?(?:image|picture|photo)\s+(?:of\s+)?(.+)/i,
        /^(?:ছবি|image|picture)\s*[:\-]\s*(.+)/i,
    ];
    for (const re of patterns) {
        const m = trimmed.match(re);
        if (m && m[1]) return m[1].trim();
    }
    return null;
}

// ── AI API Call with NxT AI ──
async function askAI(userMessage) {
    try {
        const url = `https://nxtai.site/api/use?gem=${GEM_ID}`;
        const res = await axios.post(url, {
            message: userMessage,
            prompt: userMessage
        }, {
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${NXT_API_KEY}`,
                'x-api-key': NXT_API_KEY
            },
            timeout: 30000
        });

        if (typeof res.data === 'string') return res.data;
        return res.data?.reply || res.data?.response || res.data?.message || res.data?.result || JSON.stringify(res.data);

    } catch (err) {
        pushLog('❌ NxT AI Error: ' + (err.response?.data?.error || err.message));
        return '⚠️ এই মুহূর্তে এআই সার্ভারে একটু সমস্যা হচ্ছে। দয়া করে একটু পরে চেষ্টা করুন।';
    }
}

// ── Image generation via Pollinations ──
function imageUrlFor(prompt) {
    const encoded = encodeURIComponent(prompt);
    const seed    = Math.floor(Math.random() * 1_000_000);
    return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${seed}`;
}

async function fetchImageBuffer(prompt, attempts = 4) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const url = imageUrlFor(prompt);
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 90_000,
                headers: { 'User-Agent': 'RIYAD-PERSONAL-AI/2.0' },
            });
            if (res.data && res.data.byteLength > 1000) return Buffer.from(res.data);
            throw new Error('empty image response');
        } catch (e) {
            lastErr = e;
            const status = e.response?.status;
            const wait   = status === 429 ? 5000 + i * 3000 : 2500 + i * 2000;
            pushLog(`⚠️ Image attempt ${i + 1}/${attempts} (${status || e.code || e.message}). Retry in ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr || new Error('image generation failed after all attempts');
}

// ── EXPRESS middleware ──
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        whatsapp: waConnected ? 'connected' : (waStarting ? 'pairing' : 'offline'),
    });
});

// ── API: status ──
app.get('/api/status', (_req, res) => {
    res.json({
        name: 'RIYAD PERSONAL AI',
        whatsapp: waConnected ? 'connected' : (waStarting ? 'pairing' : 'offline'),
        phoneNumber: waPhoneNumber,
        pairingCode,
        uptime: Math.floor(process.uptime()),
    });
});

// ── API: start WhatsApp pairing ──
app.post('/api/wa/start', async (req, res) => {
    const phone = (req.body?.phone || '').toString().replace(/[^0-9]/g, '');
    if (!phone || phone.length < 8) {
        return res.status(400).json({ error: 'সঠিক নম্বর দিন (country code সহ, + ছাড়া)' });
    }
    if (waConnected)  return res.json({ ok: true, message: 'WhatsApp ইতিমধ্যেই connected', phone: waPhoneNumber });
    if (waStarting)   return res.json({ ok: true, message: 'পেয়ারিং চলছে', pairingCode, phone: waPhoneNumber });

    waPhoneNumber     = phone;
    waStarting        = true;
    pairingCode       = null;
    reconnectAttempts = 0;
    pushLog(`📱 Starting WhatsApp pairing for: ${phone}`);

    startWhatsAppBot().catch(e => {
        pushLog('❌ WA bot failed: ' + e.message);
        waStarting = false;
    });
    res.json({ ok: true, message: 'পেয়ারিং শুরু হচ্ছে...', phone });
});

// ── API: Stop / Disconnect Bot ──
app.post('/api/wa/stop', async (req, res) => {
    try {
        if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
        waConnected = false;
        waStarting  = false;
        pairingCode = null;
        pushLog('🛑 Bot stopped by user.');
        res.json({ ok: true, message: 'বোট বন্ধ করা হয়েছে।' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── API: reset session ──
app.post('/api/wa/reset', async (req, res) => {
    try {
        if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        waConnected       = false;
        waStarting        = false;
        pairingCode       = null;
        waPhoneNumber     = null;
        reconnectAttempts = 0;
        pushLog('🧹 WhatsApp session reset.');
        if (req.is('application/json')) res.json({ ok: true });
        else res.redirect('/');
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── MAIN: Dashboard ──
app.get('/', (_req, res) => {
    const logHTML = logs.slice(-40).reverse()
        .map(l => `<div class="line">&gt; ${escapeHtml(l)}</div>`).join('');

    const statusBadge = waConnected
        ? '<span class="ok">● CONNECTED</span>'
        : (waStarting ? '<span class="warn">● PAIRING…</span>' : '<span class="off">● OFFLINE</span>');

    const pairingBlock = pairingCode ? `
        <div class="code-card">
            <div class="code-label">📲 PAIRING CODE</div>
            <div class="code-value">${pairingCode}</div>
            <div class="code-hint">
                WhatsApp খুলুন →
                <b>Settings → Linked Devices → Link a Device → Link with phone number</b>
                → এই কোডটি দিন
            </div>
        </div>` : '';

    const controlButtons = waConnected ? `
        <button onclick="stopBot()" class="off-btn">🔴 BOT OFF (DISCONNECT)</button>
    ` : `
        <div id="waForm">
            <input id="phone" type="tel" inputmode="numeric"
                placeholder="8801XXXXXXXXX" maxlength="15" />
            <button id="startBtn" onclick="startWA()">🟢 BOT ON (LOGIN)</button>
        </div>
    `;

    const refreshSec = pairingCode || waStarting ? 5 : 14;

    res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta name="theme-color" content="#05070d"/>
<title>RIYAD PERSONAL AI — Control Panel</title>
<meta http-equiv="refresh" content="${refreshSec}"/>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#05070d;color:#7af0ff;font-family:'JetBrains Mono',monospace;min-height:100%}
body{padding:16px;max-width:820px;margin:0 auto;padding-bottom:30px;background:#05070d}
.header{display:flex;align-items:center;gap:14px;padding:18px;background:rgba(0,30,60,.85);border:1px solid rgba(0,212,255,.3);border-radius:16px;margin-bottom:16px}
.logo{width:54px;height:54px;border-radius:14px;flex-shrink:0;background:linear-gradient(135deg,#0044ff,#00d4ff);display:flex;align-items:center;justify-content:center;font-family:'Orbitron',monospace;font-weight:900;font-size:14px;color:#fff}
.title{font-family:'Orbitron',monospace;font-size:1.15rem;color:#fff;letter-spacing:2px}
.subtitle{font-size:.62rem;color:#7ab3d4;letter-spacing:3px;text-transform:uppercase;margin-top:4px}
.status-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:.78rem;padding:12px 16px;background:rgba(0,15,35,.7);border:1px solid rgba(0,212,255,.18);border-radius:12px;margin-bottom:14px}
.ok{color:#00ff99}.warn{color:#ffcc44}.off{color:#ff5577}
.card{background:rgba(0,25,55,.7);border:1px solid rgba(0,212,255,.22);padding:20px;border-radius:14px;margin-bottom:14px}
.card h3{color:#00ffea;font-family:'Orbitron',monospace;font-size:1rem;margin-bottom:8px}
input[type=tel]{width:100%;padding:14px;background:#020510;border:1px solid rgba(0,212,255,.3);border-radius:12px;color:#00d4ff;font-size:1rem;outline:none;margin-bottom:10px}
button{padding:14px;background:linear-gradient(135deg,#0044cc,#00aaff);border:none;color:#fff;font-weight:700;border-radius:12px;cursor:pointer;font-family:'Orbitron',monospace;font-size:.85rem;width:100%;transition:.2s}
button:hover{opacity:.9}
.off-btn{background:linear-gradient(135deg,#cc0000,#ff3333)}
.code-card{background:#fff;color:#001020;padding:20px;border-radius:18px;margin-bottom:16px;text-align:center;border:2px solid #00d4ff}
.code-value{font-family:'Orbitron',monospace;font-size:2rem;font-weight:900;color:#001020;letter-spacing:5px}
.terminal-wrap{background:#020510;border:1px solid rgba(0,212,255,.25);border-radius:14px;overflow:hidden;margin-bottom:14px}
.terminal{padding:14px;height:250px;overflow-y:auto;font-size:.75rem;line-height:1.6;color:#9addff}
.line{padding:2px 0}
.footer{text-align:center;margin-top:20px;font-size:.75rem;color:#5a8aa8}
</style>
</head>
<body>
<div class="header">
  <div class="logo">RPA</div>
  <div>
    <div class="title">RIYAD PERSONAL AI</div>
    <div class="subtitle">⚡ Powered by NxT AI ⚡</div>
  </div>
</div>

<div class="status-row">
  Status: ${statusBadge}
  ${waPhoneNumber ? `&nbsp;|&nbsp; <span>📱 ${escapeHtml(waPhoneNumber)}</span>` : ''}
</div>

${pairingBlock}

<div class="card">
  <h3>⚙️ Bot Control</h3>
  ${controlButtons}
  <div id="formMsg" style="margin-top:8px;font-size:0.8rem;color:#00ffea;"></div>
</div>

<div class="card">
  <h3>📜 Terminal Logs</h3>
  <div class="terminal-wrap">
    <div class="terminal">${logHTML}</div>
  </div>
</div>

<div class="footer">DEVELOPED FOR RIYAD · PERSONAL USE ONLY</div>

<script>
async function startWA() {
  const phone = document.getElementById('phone').value.trim();
  const msg = document.getElementById('formMsg');
  if(!phone) { msg.textContent = '❌ নম্বর দিন'; return; }
  msg.textContent = '⏳ চালু হচ্ছে...';
  try {
    const res = await fetch('/api/wa/start', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ phone })
    });
    const d = await res.json();
    msg.textContent = d.message || 'চালু হয়েছে';
    setTimeout(() => location.reload(), 3000);
  } catch(e) { msg.textContent = '❌ ' + e.message; }
}

async function stopBot() {
  if(!confirm('বোট বন্ধ করতে চান?')) return;
  try {
    await fetch('/api/wa/stop', { method: 'POST' });
    location.reload();
  } catch(e) { alert(e.message); }
}
</script>
</body>
</html>`);
});

// ── Server startup ──
app.listen(PORT, '0.0.0.0', () => {
    pushLog(`✅ RIYAD PERSONAL AI running on port ${PORT}`);
    if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
        pushLog('🔁 Existing session found — auto-resuming...');
        waStarting = true;
        startWhatsAppBot().catch(e => {
            pushLog('❌ Auto-resume failed: ' + e.message);
            waStarting = false;
        });
    }
});

// ── WHATSAPP BOT ──
async function startWhatsAppBot() {
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        delay,
        fetchLatestBaileysVersion,
        DisconnectReason,
    } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
        const res = await fetchLatestBaileysVersion();
        version = res.version;
    } catch {
        version = [2, 3000, 1020576855];
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });
    waSocket = sock;

    if (!sock.authState.creds.registered) {
        if (!waPhoneNumber) {
            waStarting = false;
            return;
        }
        await delay(3000);
        try {
            pairingCode = await sock.requestPairingCode(waPhoneNumber);
            pushLog('✅ Pairing code ready: ' + pairingCode);
        } catch (err) {
            pushLog('❌ Pairing error: ' + err.message);
            waStarting = false;
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            waConnected = true;
            waStarting  = false;
            pairingCode = null;
            pushLog('🎊 AI Bot is ONLINE on WhatsApp!');
        }
        if (connection === 'close') {
            waConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                waStarting = false;
                return;
            }
            reconnectAttempts++;
            const wait = Math.min(3000 * reconnectAttempts, 30000);
            pushLog(`🔄 Reconnecting in ${wait / 1000}s…`);
            waStarting = true;
            setTimeout(() => { startWhatsAppBot().catch(() => { waStarting = false; }); }, wait);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text.trim()) return;

        const jid = msg.key.remoteJid;
        pushLog(`📩 Msg: ${text.substring(0, 30)}`);

        try {
            const imgPrompt = extractImagePrompt(text);
            if (imgPrompt) {
                const buffer = await fetchImageBuffer(imgPrompt);
                await sock.sendMessage(jid, { image: buffer, caption: `🎨 "${imgPrompt}"\n— RIYAD PERSONAL AI` });
            } else {
                const reply = await askAI(text);
                await sock.sendMessage(jid, { text: reply });
            }
        } catch (e) {
            pushLog('⚠️ Error: ' + e.message);
        }
    });
}
