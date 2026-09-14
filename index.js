// ═══════════════════════════════════════════════════════════
// 🔑 GROQ API KEY (hardcoded)
// ⚠️ GitHub-এ push করবেন না — Render Environment-এ সেট করলে
//    নিচের line-টা মুছে দিতে পারেন
// ═══════════════════════════════════════════════════════════
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || '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';

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

// ── GROQ API Config ──
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

// ── RIYAD THE AI System Prompt ──
const SYSTEM_PROMPT = `তুমি হলে "RIYAD THE AI" — একজন বন্ধু এবং সাহায্যকারী।

তোমার ব্যক্তিত্ব:
- তুমি ব্যবহারকারীর একজন বিশ্বস্ত বন্ধু এবং সব সময় সাহায্যের জন্য প্রস্তুত।
- তুমি যেকোনো প্রশ্নের সঠিক ও বিস্তারিত উত্তর দিতে পারো — পড়াশোনা, কোডিং, রান্না, ভ্রমণ, স্বাস্থ্য, বিনোদন, প্রযুক্তি, যা কিছু হোক।
- কেউ সাহায্য চাইলে তুমি বন্ধুর মতো কথা বলো — উষ্ণ, ধৈর্যশীল ও আন্তরিকভাবে।
- তুমি বাংলা, English বা যেকোনো ভাষায় উত্তর দিতে পারো — যেই ভাষায় ব্যবহারকারী লেখে তুমিও সেই ভাষায় উত্তর দিও।

ছবি তৈরি (Image Generation):
- যদি ব্যবহারকারী কোনো ছবি তৈরি করতে বলে (যেমনঃ "ছবি বানাও", "image বানাও", "draw", "generate image"), তুমি তাদের /image কমান্ডের কথা বলো।
- উদাহরণঃ "/image একটা সূর্যাস্তের ছবি" — এভাবে লিখলেই আমি ছবি তৈরি করে দেব।

সর্বদা সংক্ষিপ্ত, পরিষ্কার ও সহায়ক উত্তর দাও। মিথ্যা তথ্য দিও না — না জানলে সরাসরি বলে দাও।`;

// ── State ──
let logs      = ['🚀 RIYAD THE AI starting up...'];
let pairingCode  = null;
let waConnected  = false;
let waSocket     = null;
let waStarting   = false;
let waPhoneNumber = null;
let reconnectAttempts = 0;
let isShuttingDown = false;

function pushLog(msg) {
    const ts = new Date().toLocaleTimeString('bn-BD');
    const line = `[${ts}] ${msg}`;
    logs.push(line);
    if (logs.length > 200) logs = logs.slice(-200);
    console.log(line);
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

// ── AI via Groq (with retry) ──
async function askAI(userMessage, attempts = 3) {
    if (!GROQ_API_KEY) {
        pushLog('❌ GROQ_API_KEY is missing!');
        return '⚠️ AI সার্ভার কনফিগার করা হয়নি (API key missing)।';
    }

    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await axios.post(
                GROQ_URL,
                {
                    model: GROQ_MODEL,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user',   content: userMessage }
                    ],
                    temperature: 0.7,
                    max_tokens: 2048,
                    top_p: 0.9,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${GROQ_API_KEY}`,
                        'Content-Type':  'application/json',
                    },
                    timeout: 60_000,
                }
            );

            const reply = res.data?.choices?.[0]?.message?.content;
            if (typeof reply === 'string' && reply.trim()) {
                return reply.trim();
            }
            throw new Error('empty reply from Groq');
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            const detail = err.response?.data?.error?.message || err.message;
            pushLog(`❌ Groq attempt ${i + 1}/${attempts} [${status || err.code}]: ${detail}`);

            if (status === 401 || status === 403) {
                return '⚠️ AI API key ভুল বা expired। Admin-কে জানান।';
            }
            if (status === 429) {
                await new Promise(r => setTimeout(r, 5000 + i * 3000));
                continue;
            }
            await new Promise(r => setTimeout(r, 2000 + i * 1500));
        }
    }

    if (lastErr?.response?.status === 429) {
        return '⚠️ অনেক request হয়ে গেছে, একটু পরে আবার চেষ্টা করুন।';
    }
    return '⚠️ দুঃখিত, AI সার্ভারে সাময়িক সমস্যা। একটু পরে আবার চেষ্টা করুন।';
}

// ── Image generation via Pollinations ──
function imageUrlFor(prompt) {
    const encoded = encodeURIComponent(prompt);
    const seed    = Math.floor(Math.random() * 1_000_000);
    return `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${seed}`;
}

async function fetchImageBuffer(prompt, attempts = 4) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const url = imageUrlFor(prompt);
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 90_000,
                headers: { 'User-Agent': 'RIYAD-THE-AI/2.0' },
            });
            if (res.data && res.data.byteLength > 1000) {
                return Buffer.from(res.data);
            }
            throw new Error('empty image response');
        } catch (e) {
            lastErr = e;
            const status = e.response?.status;
            const wait   = status === 429 ? 5000 + i * 3000 : 2500 + i * 2000;
            pushLog(`⚠️ Image attempt ${i + 1}/${attempts} (${status || e.code || e.message}). Retry in ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr || new Error('image generation failed');
}

// ── Express middleware ──
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        whatsapp: waConnected ? 'connected' : (waStarting ? 'pairing' : 'offline'),
        ai: GROQ_API_KEY ? 'configured' : 'missing-key',
    });
});

// ── API: status ──
app.get('/api/status', (_req, res) => {
    res.json({
        name: 'RIYAD THE AI',
        whatsapp: waConnected ? 'connected' : (waStarting ? 'pairing' : 'offline'),
        phoneNumber: waPhoneNumber,
        pairingCode,
        uptime: Math.floor(process.uptime()),
        aiConfigured: !!GROQ_API_KEY,
    });
});

// ── API: test AI ──
app.get('/api/test-ai', async (_req, res) => {
    const reply = await askAI('হ্যালো, এক লাইনে বলো তুমি কে?');
    res.json({ reply });
});

// ── API: start WhatsApp pairing ──
app.post('/api/wa/start', async (req, res) => {
    const phone = (req.body?.phone || '').toString().replace(/[^0-9]/g, '');
    if (!phone || phone.length < 8) {
        return res.status(400).json({ error: 'সঠিক নম্বর দিন (country code সহ, + ছাড়া)' });
    }
    if (waConnected) return res.json({ ok: true, message: 'WhatsApp ইতিমধ্যেই connected', phone: waPhoneNumber });
    if (waStarting)  return res.json({ ok: true, message: 'পেয়ারিং চলছে', pairingCode, phone: waPhoneNumber });

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

// ── API: reset session ──
app.post('/api/wa/reset', async (req, res) => {
    try {
        if (waSocket) { try { waSocket.end(); } catch (_) {} waSocket = null; }
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        waConnected = false;
        waStarting  = false;
        pairingCode = null;
        waPhoneNumber = null;
        reconnectAttempts = 0;
        pushLog('🧹 WhatsApp session reset.');
        if (req.is('application/json')) res.json({ ok: true });
        else res.redirect('/');
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── MAIN: Terminal Dashboard ──
app.get('/', (_req, res) => {
    const logHTML = logs.slice(-40).reverse()
        .map(l => `<div class="line">&gt; ${escapeHtml(l)}</div>`).join('');

    const statusBadge = waConnected
        ? '<span class="ok">● CONNECTED</span>'
        : (waStarting ? '<span class="warn">● PAIRING…</span>' : '<span class="off">● OFFLINE</span>');

    const aiBadge = GROQ_API_KEY
        ? '<span class="ok">● AI READY</span>'
        : '<span class="off">● AI KEY MISSING</span>';

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

    const formBlock = (waConnected || waStarting) ? '' : `
        <div class="card">
            <h3>📱 WhatsApp Bot Login</h3>
            <p class="muted">Country code সহ আপনার WhatsApp নম্বর দিন (+ ছাড়া)।<br>
            উদাহরণঃ <code>8801712345678</code></p>
            <div id="waForm">
                <input id="phone" type="tel" inputmode="numeric"
                    placeholder="8801XXXXXXXXX" maxlength="15" />
                <button id="startBtn" onclick="startWA()">🚀 LOGIN START</button>
            </div>
            <div id="formMsg" class="muted"></div>
        </div>`;

    const resetBlock = (waConnected || waStarting) ? `
        <form method="POST" action="/api/wa/reset"
              onsubmit="return confirm('Session reset হবে — আবার pair করতে হবে। চালিয়ে যাবেন?')">
            <button type="submit" class="reset-btn">🧹 RESET SESSION</button>
        </form>` : '';

    const refreshSec = pairingCode || waStarting ? 5 : 14;

    res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta name="theme-color" content="#05070d"/>
<title>RIYAD THE AI — WhatsApp Bot Terminal</title>
<meta http-equiv="refresh" content="${refreshSec}"/>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#05070d;color:#7af0ff;font-family:'JetBrains Mono',monospace;min-height:100%}
body{padding:16px;max-width:820px;margin:0 auto;padding-bottom:30px;
  background:radial-gradient(ellipse at top,rgba(0,200,255,.08),transparent 60%),
    radial-gradient(ellipse at bottom,rgba(120,0,255,.06),transparent 60%),#05070d;
  background-attachment:fixed;}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;opacity:.35;
  background-image:linear-gradient(rgba(0,212,255,.04) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,212,255,.04) 1px,transparent 1px);
  background-size:40px 40px;}
body>*{position:relative;z-index:1}
.header{display:flex;align-items:center;gap:14px;padding:18px;
  background:linear-gradient(135deg,rgba(0,30,60,.85),rgba(20,0,60,.7));
  border:1px solid rgba(0,212,255,.3);border-radius:16px;margin-bottom:16px;
  box-shadow:0 0 30px rgba(0,212,255,.12),inset 0 0 30px rgba(0,212,255,.04);
  backdrop-filter:blur(8px);}
.logo{width:54px;height:54px;border-radius:14px;flex-shrink:0;
  background:linear-gradient(135deg,#0044ff,#00d4ff,#00ffaa);
  display:flex;align-items:center;justify-content:center;
  font-family:'Orbitron',monospace;font-weight:900;font-size:14px;color:#fff;
  letter-spacing:-1px;box-shadow:0 0 24px rgba(0,212,255,.6),inset 0 0 12px rgba(255,255,255,.2);}
.title{font-family:'Orbitron',monospace;font-size:1.15rem;color:#fff;letter-spacing:3px;text-shadow:0 0 12px rgba(0,212,255,.6)}
.subtitle{font-size:.62rem;color:#7ab3d4;letter-spacing:4px;text-transform:uppercase;margin-top:4px}
.status-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:.78rem;
  padding:12px 16px;background:rgba(0,15,35,.7);border:1px solid rgba(0,212,255,.18);
  border-radius:12px;margin-bottom:14px;}
.ok{color:#00ff99;text-shadow:0 0 8px rgba(0,255,150,.5)}
.warn{color:#ffcc44;text-shadow:0 0 8px rgba(255,200,68,.5);animation:blink 1s infinite}
.off{color:#ff5577}
@keyframes blink{50%{opacity:.4}}
.phone{color:#fff;font-weight:600;letter-spacing:1px}
.card{background:linear-gradient(135deg,rgba(0,25,55,.7),rgba(15,0,40,.5));
  border:1px solid rgba(0,212,255,.22);padding:20px;border-radius:14px;margin-bottom:14px;
  backdrop-filter:blur(6px);}
.card h3{color:#00ffea;font-family:'Orbitron',monospace;letter-spacing:2px;
  margin-bottom:8px;font-size:1rem;text-shadow:0 0 8px rgba(0,255,234,.4);}
.card p,.muted{color:#9ec4dc;font-size:.82rem;line-height:1.6;margin-bottom:12px}
code{background:rgba(0,40,80,.7);color:#00ffea;padding:3px 8px;border-radius:5px;font-size:.85rem;border:1px solid rgba(0,212,255,.2)}
#waForm{display:flex;flex-direction:column;gap:10px}
input[type=tel]{width:100%;padding:16px 18px;background:#020510;
  border:1px solid rgba(0,212,255,.3);border-radius:12px;color:#00d4ff;
  font-family:'JetBrains Mono',monospace;font-size:1.05rem;outline:none;
  letter-spacing:2px;transition:all .2s;}
input[type=tel]:focus{border-color:#00d4ff;box-shadow:0 0 0 3px rgba(0,212,255,.15),0 0 24px rgba(0,212,255,.4)}
button{padding:15px;background:linear-gradient(135deg,#0044cc,#00aaff,#0066ff);
  background-size:200% 100%;border:none;color:#fff;font-weight:700;border-radius:12px;
  cursor:pointer;font-family:'Orbitron',monospace;font-size:.9rem;letter-spacing:3px;
  transition:all .25s;box-shadow:0 4px 16px rgba(0,100,200,.4);}
button:hover{background-position:100% 0;transform:translateY(-2px);box-shadow:0 0 28px rgba(0,200,255,.6)}
button:active{transform:scale(.98)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
.reset-btn{margin-top:14px;width:100%;padding:13px;font-size:.78rem;
  background:linear-gradient(135deg,#5a1525,#a02538);
  border:1px solid rgba(255,90,110,.4);color:#ffbbcc;}
.code-card{background:linear-gradient(135deg,#fff,#d4f1ff,#fff);color:#001020;
  padding:26px 20px;border-radius:18px;margin-bottom:16px;text-align:center;
  border:2px solid #00d4ff;box-shadow:0 0 50px rgba(0,212,255,.55);
  animation:pulse 2s ease-in-out infinite;}
@keyframes pulse{0%,100%{box-shadow:0 0 30px rgba(0,212,255,.4)}50%{box-shadow:0 0 70px rgba(0,212,255,.8)}}
.code-label{font-family:'Orbitron',monospace;font-size:.78rem;letter-spacing:4px;color:#003866;margin-bottom:10px}
.code-value{font-family:'Orbitron',monospace;font-size:2.6rem;font-weight:900;letter-spacing:10px;color:#001020;word-break:break-all}
.code-hint{font-size:.78rem;color:#003866;margin-top:14px;line-height:1.6}
.terminal-wrap{background:#020510;border:1px solid rgba(0,212,255,.25);border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:inset 0 0 30px rgba(0,212,255,.05)}
.terminal-bar{display:flex;align-items:center;gap:6px;padding:8px 14px;background:rgba(0,212,255,.08);border-bottom:1px solid rgba(0,212,255,.15);font-size:.7rem;color:#7ab3d4;letter-spacing:2px}
.dot{width:10px;height:10px;border-radius:50%;background:#ff5577}
.dot.y{background:#ffcc44}.dot.g{background:#00ff99}
.terminal-bar .label{margin-left:auto;font-family:'Orbitron',monospace}
.terminal{padding:14px;height:38vh;min-height:260px;overflow-y:auto;font-size:.8rem;line-height:1.8}
.terminal::-webkit-scrollbar{width:6px}
.terminal::-webkit-scrollbar-thumb{background:rgba(0,212,255,.4);border-radius:3px}
.line{padding:2px 0;color:#9addff;word-break:break-word;border-left:2px solid transparent;padding-left:8px;transition:border .2s}
.line:hover{border-left-color:#00d4ff;background:rgba(0,212,255,.04)}
.section-title{color:#00ffea;font-family:'Orbitron',monospace;font-size:.82rem;letter-spacing:3px;margin:20px 0 10px 4px;text-shadow:0 0 8px rgba(0,255,234,.3)}
#formMsg{margin-top:6px;color:#00ffea;font-size:.85rem;min-height:1.2em;letter-spacing:1px}
.commands{font-size:.82rem;color:#9ec4dc;line-height:1.9;margin-top:6px}
.commands b{color:#00ffea}
.footer{margin-top:24px;padding:18px 16px;text-align:center;background:linear-gradient(135deg,rgba(0,20,50,.7),rgba(30,0,60,.5));border:1px solid rgba(0,212,255,.2);border-radius:14px}
.footer .dev{font-family:'Orbitron',monospace;font-size:.95rem;letter-spacing:3px;background:linear-gradient(90deg,#00d4ff,#aa66ff,#00ffaa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:800}
.footer a{display:inline-block;margin-top:8px;color:#7ad8ff;text-decoration:none;font-size:.82rem;padding:6px 14px;border:1px solid rgba(0,212,255,.3);border-radius:20px;transition:all .2s}
.footer a:hover{background:rgba(0,212,255,.12);box-shadow:0 0 14px rgba(0,212,255,.3)}
.footer .tag{font-size:.65rem;color:#5a8aa8;margin-top:8px;letter-spacing:2px}
@media(max-width:480px){.code-value{font-size:1.9rem;letter-spacing:6px}.title{font-size:.95rem;letter-spacing:2px}.logo{width:46px;height:46px;font-size:12px}body{padding:12px}}
</style>
</head>
<body>

<div class="header">
  <div class="logo">RTA</div>
  <div>
    <div class="title">RIYAD THE AI</div>
    <div class="subtitle">⚡ WhatsApp Bot Terminal ⚡</div>
  </div>
</div>

<div class="status-row">
  WA: ${statusBadge} &nbsp;|&nbsp; AI: ${aiBadge}
  ${waPhoneNumber ? `&nbsp;|&nbsp; <span class="phone">📱 ${escapeHtml(waPhoneNumber)}</span>` : ''}
</div>

${pairingBlock}
${formBlock}

<div class="card" style="padding:16px 20px">
  <h3>💡 Bot Commands</h3>
  <div class="commands">
    • <b>যেকোনো প্রশ্ন</b> → AI সাথে সাথে উত্তর দেবে<br>
    • <b>/image সূর্যাস্ত</b> → ছবি তৈরি করবে<br>
    • <b>একটা গাড়ির ছবি বানাও</b> → ছবি তৈরি করবে<br>
    • <b>draw a cat</b> → ইংরেজিতেও কাজ করবে
  </div>
</div>

<div class="section-title">📜 LIVE TERMINAL LOGS</div>
<div class="terminal-wrap">
  <div class="terminal-bar">
    <span class="dot"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="label">riyad@ai:~$</span>
  </div>
  <div class="terminal">${logHTML}</div>
</div>

${resetBlock}

<div class="footer">
  <div class="dev">『 R I Y A D 』</div>
  <a href="https://t.me/zerox6t9" target="_blank" rel="noopener">📩 t.me/zerox6t9</a>
  <div class="tag">DEVELOPED · MAINTAINED · POWERED BY RIYAD</div>
</div>

<script>
async function startWA() {
  const phone = document.getElementById('phone').value.trim();
  const msg   = document.getElementById('formMsg');
  const btn   = document.getElementById('startBtn');
  if (!phone || phone.length < 8) { msg.textContent = '❌ সঠিক নম্বর দিন'; return; }
  msg.textContent = '⏳ পেয়ারিং শুরু হচ্ছে...';
  btn.disabled = true;
  try {
    const r = await fetch('/api/wa/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const d = await r.json();
    msg.textContent = d.ok ? '✅ ' + d.message : '❌ ' + (d.error || 'failed');
    if (d.ok) setTimeout(() => location.reload(), 2500);
    else btn.disabled = false;
  } catch (err) {
    msg.textContent = '❌ ' + err.message;
    btn.disabled = false;
  }
}
document.getElementById('phone') &&
  document.getElementById('phone').addEventListener('keydown', e => { if (e.key === 'Enter') startWA(); });
</script>
</body>
</html>`);
});

// ── Server startup ──
app.listen(PORT, '0.0.0.0', () => {
    pushLog(`✅ RIYAD THE AI running on port ${PORT}`);
    pushLog(`📁 Auth dir: ${AUTH_DIR}`);
    pushLog(`🤖 AI: ${GROQ_API_KEY ? 'Groq (' + GROQ_MODEL + ')' : '❌ GROQ_API_KEY missing!'}`);

    if (!GROQ_API_KEY) {
        pushLog('⚠️  Please set GROQ_API_KEY in environment variables.');
        pushLog('⚠️  Get free key: https://console.groq.com/keys');
    }

    // Auto-resume if session exists
    if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
        pushLog('🔁 Existing session found — auto-resuming...');
        waStarting = true;
        startWhatsAppBot().catch(e => {
            pushLog('❌ Auto-resume failed: ' + e.message);
            waStarting = false;
        });
    } else {
        pushLog('ℹ️ Open terminal page and enter your WhatsApp number to login.');
    }

    // Self-ping to keep Render free tier awake
    const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
    if (selfUrl) {
        const pingUrl = selfUrl.replace(/\/$/, '') + '/health';
        pushLog(`🏓 Self-ping enabled → ${pingUrl} (every 13 min)`);
        setInterval(async () => {
            if (isShuttingDown) return;
            try {
                await axios.get(pingUrl, { timeout: 10_000 });
                pushLog('🏓 Self-ping OK');
            } catch (e) {
                pushLog('⚠️ Self-ping failed: ' + e.message);
            }
        }, 13 * 60 * 1000);
    }
});

// ── Graceful shutdown ──
['SIGINT', 'SIGTERM'].forEach(sig => {
    process.on(sig, () => {
        isShuttingDown = true;
        pushLog(`🛑 Received ${sig} — shutting down...`);
        if (waSocket) { try { waSocket.end(); } catch (_) {} }
        setTimeout(() => process.exit(0), 1500);
    });
});

// ══════════════════════════════════════════
// WHATSAPP BOT
// ══════════════════════════════════════════
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
        pushLog(`📦 Baileys: ${version.join('.')}`);
    } catch {
        version = [2, 3000, 1020576855];
        pushLog('⚠️ Using fallback Baileys version.');
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
    });
    waSocket = sock;

    // Request pairing code if not registered
    if (!sock.authState.creds.registered) {
        if (!waPhoneNumber) {
            pushLog('⚠️ No phone number set. Enter it on the terminal page.');
            waStarting = false;
            return;
        }
        pushLog('🔑 Requesting pairing code for ' + waPhoneNumber + '...');
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
            reconnectAttempts = 0;
            pushLog('🎊 RIYAD THE AI is ONLINE on WhatsApp!');
        }

        if (connection === 'close') {
            waConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;

            if (loggedOut) {
                pushLog('🚪 Logged out. Please reset and re-pair.');
                waStarting = false;
                return;
            }

            if (isShuttingDown) return;

            reconnectAttempts++;
            const wait = Math.min(3000 * reconnectAttempts, 30000);
            pushLog(`🔄 Disconnected (code ${code}). Reconnecting in ${wait / 1000}s… (attempt ${reconnectAttempts})`);
            waStarting = true;
            setTimeout(() => {
                if (isShuttingDown) return;
                startWhatsAppBot().catch(e => {
                    pushLog('❌ Reconnect failed: ' + e.message);
                    waStarting = false;
                });
            }, wait);
        }
    });

    const seenMsgs  = new Set();
    const busyChats = new Set();

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        // Skip status broadcasts
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return;

        const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || msg.message.imageMessage?.caption
            || '';
        if (!text.trim()) return;

        const msgId = msg.key.id;
        if (seenMsgs.has(msgId)) return;
        seenMsgs.add(msgId);
        if (seenMsgs.size > 500) seenMsgs.clear();

        if (busyChats.has(jid)) {
            pushLog(`⏭️ Busy: ${text.substring(0, 24)}`);
            return;
        }
        busyChats.add(jid);
        pushLog(`📩 WA from ${jid.split('@')[0]}: ${text.substring(0, 40)}`);

        // Typing indicator
        let typingTimer = null;
        const startTyping = async () => {
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (_) {}
            typingTimer = setInterval(() => {
                sock.sendPresenceUpdate('composing', jid).catch(() => {});
            }, 8000);
        };
        const stopTyping = async () => {
            if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
            try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
        };

        try {
            try { await sock.readMessages([msg.key]); } catch (_) {}
            await startTyping();

            const imgPrompt = extractImagePrompt(text);
            if (imgPrompt) {
                pushLog('🎨 Image: ' + imgPrompt.substring(0, 30));
                try {
                    const buffer = await fetchImageBuffer(imgPrompt);
                    await stopTyping();
                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: `🎨 "${imgPrompt}"\n\n— RIYAD THE AI\n👨‍💻 『 R I Y A D 』 t.me/zerox6t9`,
                    });
                    pushLog('🖼️ Image sent.');
                } catch (imgErr) {
                    pushLog('❌ Image error: ' + (imgErr.response?.status || imgErr.message));
                    await stopTyping();
                    await sock.sendMessage(jid, {
                        text: '⚠️ ছবি তৈরি করতে সার্ভার এখন ব্যস্ত। ৩০ সেকেন্ড পরে আবার চেষ্টা করুন।',
                    });
                }
            } else {
                const reply = await askAI(text);
                await stopTyping();
                await sock.sendMessage(jid, { text: reply });
                pushLog('📤 Reply sent.');
            }
        } catch (e) {
            await stopTyping();
            pushLog('⚠️ Handler error: ' + e.message);
        } finally {
            busyChats.delete(jid);
        }
    });
                                                  }
