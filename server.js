const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sms = require('./sms');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const QUEUE_NAME = process.env.QUEUE_NAME || 'Rentertainment F1 Simulator';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_SERVICE_SEC = 180;
const ACTIVE = ['waiting', 'called'];
const TRACKS = ['Australia', 'Las Vegas', 'Miami', 'Austin'];
const TRANSMISSIONS = ['Auto', 'Manual'];

// ---------- state ----------
let state = { nextNumber: 1, open: true, tickets: [] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (_) { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  }, 100);
}

const waiting = () => state.tickets.filter(t => t.status === 'waiting').sort((a, b) => a.number - b.number);
const called = () => state.tickets.filter(t => t.status === 'called').sort((a, b) => b.calledAt - a.calledAt);
const find = id => state.tickets.find(t => t.id === id);

// Average seconds between the last few "calls" — a simple, self-tuning wait estimate.
function avgServiceSec() {
  const times = state.tickets.filter(t => t.calledAt).map(t => t.calledAt).sort((a, b) => a - b).slice(-11);
  if (times.length < 3) return DEFAULT_SERVICE_SEC;
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000).filter(g => g < 3600);
  if (!gaps.length) return DEFAULT_SERVICE_SEC;
  return Math.max(30, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length));
}

function publicState() {
  return {
    queueName: QUEUE_NAME,
    open: state.open,
    nowServing: called().slice(0, 4).map(t => ({ number: t.number, counter: t.counter, calledAt: t.calledAt })),
    waitingNumbers: waiting().map(t => t.number),
    avgServiceSec: avgServiceSec(),
  };
}

function ticketView(t) {
  const w = waiting();
  const ahead = t.status === 'waiting' ? w.findIndex(x => x.id === t.id) : 0;
  return {
    id: t.id, number: t.number, name: t.firstName || t.name, track: t.track, transmission: t.transmission, status: t.status, counter: t.counter,
    createdAt: t.createdAt, calledAt: t.calledAt, recallAt: t.recallAt,
    ahead, estWaitSec: ahead * avgServiceSec(), queueName: QUEUE_NAME,
  };
}

// ---------- live updates (SSE) ----------
const clients = new Set();
function broadcast(extra = {}) {
  const data = `data: ${JSON.stringify({ ...publicState(), ...extra })}\n\n`;
  for (const res of clients) res.write(data);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function changed(extra) { checkNextUp(); save(); broadcast(extra); }

// ---------- text messages ----------
function ticketLink(t) { return PUBLIC_URL ? ` Live status: ${PUBLIC_URL}/t/${t.id}` : ''; }
const SMS_TEXT = {
  next: t => `${QUEUE_NAME}: Hi ${t.firstName}, you're next! Please make your way to the simulator now. Ticket #${t.number}.${ticketLink(t)}`,
  called: t => `${QUEUE_NAME}: Hi ${t.firstName}, it's your turn! Please go to ${t.counter} now. Ticket #${t.number}.`,
  recall: t => `${QUEUE_NAME}: Reminder ${t.firstName} - we're waiting for you at ${t.counter}. Ticket #${t.number}.`,
};
function textCustomer(t, kind) {
  if (!t.phone) return;
  const entry = { kind, at: Date.now(), status: 'sending' };
  (t.sms = t.sms || []).push(entry);
  sms.send(t.phone, SMS_TEXT[kind](t)).then(r => {
    Object.assign(entry, r);
    save(); broadcast();
  });
}
// Text whoever has just moved to the front of the queue (once per ticket).
function checkNextUp() {
  const first = waiting()[0];
  if (first && !first.smsNext) { first.smsNext = true; textCustomer(first, 'next'); }
}

// ---------- helpers ----------
function lanIp() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.get('host') || '';
  if (/^(localhost|127\.)/.test(host)) return `http://${lanIp()}:${PORT}`;
  return `${req.protocol}://${host}`;
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => res.redirect('/join'));
app.get('/t/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticket.html')));

app.get('/api/info', (req, res) => res.json({ queueName: QUEUE_NAME, joinUrl: baseUrl(req) + '/join' }));

app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(baseUrl(req) + '/join', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Customer API
app.post('/api/join', (req, res) => {
  if (!state.open) return res.status(403).json({ error: 'The queue is closed right now.' });
  const firstName = clean(req.body.firstName, 40);
  const lastName = clean(req.body.lastName, 40);
  const email = clean(req.body.email, 120).toLowerCase();
  const track = clean(req.body.track, 30);
  const transmission = clean(req.body.transmission, 20);
  if (!firstName) return res.status(400).json({ error: 'Please enter your first name.' });
  if (!lastName) return res.status(400).json({ error: 'Please enter your last name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!TRACKS.includes(track)) return res.status(400).json({ error: 'Please choose a track.' });
  if (!TRANSMISSIONS.includes(transmission)) return res.status(400).json({ error: 'Please choose a transmission.' });
  const phone = sms.normalisePhone(req.body.countryCode, req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Please enter a valid mobile number, including the right country code.' });
  const t = {
    id: crypto.randomBytes(12).toString('base64url'),
    number: state.nextNumber++,
    name: `${firstName} ${lastName}`,
    firstName, lastName, email, phone, track, transmission,
    status: 'waiting',
    createdAt: Date.now(),
  };
  if (!waiting().length) t.smsNext = true;
  state.tickets.push(t);
  changed();
  res.json(ticketView(t));
});

app.get('/api/tickets/:id', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticketView(t));
});

app.post('/api/tickets/:id/leave', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  if (ACTIVE.includes(t.status)) { t.status = 'left'; t.finishedAt = Date.now(); changed(); }
  res.json(ticketView(t));
});

// Staff API
const admin = express.Router();
admin.use((req, res, next) => {
  const pin = req.get('x-admin-pin') || '';
  const ok = pin.length === ADMIN_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN));
  return ok ? next() : res.status(401).json({ error: 'Wrong PIN' });
});

admin.get('/state', (req, res) => {
  const since = Date.now() - 12 * 3600 * 1000;
  res.json({
    ...publicState(),
    smsEnabled: sms.enabled,
    waiting: waiting(),
    called: called(),
    recent: state.tickets.filter(t => !ACTIVE.includes(t.status) && (t.finishedAt || 0) > since)
      .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 30),
    servedToday: state.tickets.filter(t => t.status === 'served' && t.finishedAt > since).length,
  });
});

function finishCounter(counter) {
  for (const t of called()) if (t.counter === counter) { t.status = 'served'; t.finishedAt = Date.now(); }
}
function callTicket(t, counter) {
  finishCounter(counter);
  t.status = 'called'; t.counter = counter; t.calledAt = Date.now();
  t.smsNext = true;
  textCustomer(t, 'called');
}

admin.post('/call-next', (req, res) => {
  const counter = clean(req.body.counter, 20) || '1';
  const next = waiting()[0];
  if (!next) { finishCounter(counter); changed(); return res.json({ ticket: null }); }
  callTicket(next, counter);
  changed({ chime: next.number });
  res.json({ ticket: next });
});

admin.post('/tickets/:id/:action', (req, res) => {
  const t = find(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const counter = clean(req.body.counter, 20) || t.counter || '1';
  let extra;
  switch (req.params.action) {
    case 'call': callTicket(t, counter); extra = { chime: t.number }; break;
    case 'recall': t.recallAt = Date.now(); textCustomer(t, 'recall'); extra = { chime: t.number }; break;
    case 'serve': t.status = 'served'; t.finishedAt = Date.now(); break;
    case 'noshow': t.status = 'noshow'; t.finishedAt = Date.now(); break;
    case 'remove': t.status = 'removed'; t.finishedAt = Date.now(); break;
    case 'requeue': t.status = 'waiting'; delete t.counter; delete t.finishedAt; delete t.smsNext; break;
    default: return res.status(400).json({ error: 'Unknown action' });
  }
  changed(extra);
  res.json({ ticket: t });
});

admin.post('/open', (req, res) => { state.open = !!req.body.open; changed(); res.json({ open: state.open }); });

admin.post('/reset', (req, res) => {
  state.tickets = [];
  state.nextNumber = 1;
  changed();
  res.json({ ok: true });
});

app.use('/api/admin', admin);

app.listen(PORT, () => {
  console.log(`Queue running on http://localhost:${PORT}`);
  console.log(`  Display (show QR): http://localhost:${PORT}/display`);
  console.log(`  Staff console:     http://localhost:${PORT}/admin   (PIN: ${process.env.ADMIN_PIN ? 'from ADMIN_PIN' : '1234'})`);
  console.log(`  Text messages:     ${sms.enabled ? 'ON (Twilio)' : 'OFF - set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM'}`);
  console.log(`  Phones will join:  ${PUBLIC_URL || `http://${lanIp()}:${PORT}`}/join`);
});
