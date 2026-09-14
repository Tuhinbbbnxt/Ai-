require('dotenv').config();
const express = require('express');
const pino    = require('pino');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth directory ──
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

// ── State ──
let logs          = ['🚀 OFFLINE NOTIFIER BOT starting up...'];
let pairingCode   = null;
let waConnected   = false;
let waSocket      = null;
let waStarting    = false;
let waPhoneNumber = null;
let reconnectAttempts = 0;

// ইউজারদের ট্র্যাক রাখার জন্য মেমোরি (শেষ কখন মেসেজ দিয়েছে এবং নোটিফিকেশন পাঠানো হয়েছে)
const lastRepliedMap = new Map();
const COOLDOWN_TIME  = 30 * 60 * 1000; // ৩০ মিনিট (এই সময়ের মধ্যে একই ইউজারকে বারবার মেসেজ পাঠাবে না)

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
        name: 'OFFLINE NOTIFIER BOT',
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

// ── API: Stop Bot ──
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

// ── Dashboard ──
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

    res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta http-equiv="refresh" content="10"/>
<title>OFFLINE NOTIFIER BOT</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#05070d;color:#7af0ff;font-family:monospace;padding:16px;max-width:820px;margin:0 auto}
.header{padding:18px;background:rgba(0,30,60,.85);border:1px solid rgba(0,212,255,.3);border-radius:16px;margin-bottom:16px;text-align:center}
.status-row{padding:12px 16px;background:rgba(0,15,35,.7);border:1px solid rgba(0,212,255,.18);border-radius:12px;margin-bottom:14px}
.ok{color:#00ff99}.warn{color:#ffcc44}.off{color:#ff5577}
.card{background:rgba(0,25,55,.7);border:1px solid rgba(0,212,255,.22);padding:20px;border-radius:14px;margin-bottom:14px}
input[type=tel]{width:100%;padding:14px;background:#020510;border:1px solid rgba(0,212,255,.3);border-radius:12px;color:#00d4ff;font-size:1rem;margin-bottom:10px}
button{padding:14px;background:linear-gradient(135deg,#0044cc,#00aaff);border:none;color:#fff;font-weight:700;border-radius:12px;cursor:pointer;width:100%}
.off-btn{background:linear-gradient(135deg,#cc0000,#ff3333)}
.code-card{background:#fff;color:#001020;padding:20px;border-radius:18px;margin-bottom:16px;text-align:center}
.code-value{font-size:2rem;font-weight:900;letter-spacing:5px}
.terminal{padding:14px;height:200px;overflow-y:auto;font-size:.75srem;background:#020510;color:#9addff;border-radius:10px}
.line{padding:2px 0}
</style>
</head>
<body>
<div class="header"><h2>🤖 OFFLINE AUTO-REPLY BOT</h2></div>
<div class="status-row">Status: ${statusBadge}</div>
${pairingBlock}
<div class="card">
  <h3>⚙️ Control</h3>
  ${controlButtons}
  <div id="formMsg" style="margin-top:8px;color:#00ffea;"></div>
</div>
<div class="card">
  <h3>📜 Logs</h3>
  <div class="terminal">${logHTML}</div>
</div>
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
    msg.textContent = d.message;
    setTimeout(() => location.reload(), 3000);
  } catch(e) { msg.textContent = '❌ ' + e.message; }
}
async function stopBot() {
  try { await fetch('/api/wa/stop', { method: 'POST' }); location.reload(); } catch(e) {}
}
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
    pushLog(`✅ Server running on port ${PORT}`);
    if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
        waStarting = true;
        startWhatsAppBot().catch(() => { waStarting = false; });
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
        if (!waPhoneNumber) { waStarting = false; return; }
        await delay(3000);
        try {
            pairingCode = await sock.requestPairingCode(waPhoneNumber);
            pushLog('✅ Pairing code: ' + pairingCode);
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
            pushLog('🎊 Bot is ONLINE!');
        }
        if (connection === 'close') {
            waConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) { waStarting = false; return; }
            reconnectAttempts++;
            waStarting = true;
            setTimeout(() => { startWhatsAppBot().catch(() => { waStarting = false; }); }, 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        // গ্রুপ চ্যাট ইগনোর করতে চাইলে (শুধু ইনবক্সের জন্য কাজ করবে)
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us')) return; 

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text.trim()) return;

        const now = Date.now();
        const lastTime = lastRepliedMap.get(jid) || 0;

        // যদি ৩০ মিনিটের মধ্যে ইউজার আগে মেসেজ না করে থাকে, তবেই মেসেজ পাঠাবে
        if (now - lastTime > COOLDOWN_TIME) {
            lastRepliedMap.set(jid, now);
            
            const replyText = "আপনি যাকে মেসেজ করেছেন সে এখন অফলাইনে আছে আপনি চাইলে আমাকে বলতে পারেন আমি তার এআই অ্যাসিস্ট্যান্ট বট বলছি।";
            
            try {
                await sock.sendMessage(jid, { text: replyText });
                pushLog(`📤 Offline notice sent to ${jid.split('@')[0]}`);
            } catch (e) {
                pushLog('⚠️ Send error: ' + e.message);
            }
        }
    });
}
