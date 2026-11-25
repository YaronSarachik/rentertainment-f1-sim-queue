// SMS sending via Twilio's REST API (no SDK needed).
// If the TWILIO_* variables aren't set, messages are printed to the console instead,
// so the app still works for testing.
const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM || ''; // a Twilio number like +614xxxxxxxx, or an approved sender ID like "Rentertain"
const API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';

const enabled = !!(SID && TOKEN && FROM);

// Combine the chosen country code with the number typed and return E.164 (+614...).
// A leading 0 (the local "trunk" prefix, e.g. 0412...) is dropped. If the person typed a full
// international number starting with +, that is used as-is.
function normalisePhone(countryCode, raw) {
  let s = String(raw || '').replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    const cc = String(countryCode || '+61').replace(/[^\d]/g, '');
    if (!cc) return null;
    s = '+' + cc + s.replace(/^0+/, '');
  }
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  if (s.startsWith('+61') && !/^\+614\d{8}$/.test(s)) return null; // Australian mobiles: 04xx xxx xxx
  return s;
}

async function send(to, body) {
  if (!enabled) {
    console.log(`[sms:not-configured] to ${to}: ${body}`);
    return { status: 'not-configured' };
  }
  try {
    const r = await fetch(`${API_BASE}/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: FROM, Body: body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[sms] failed to ${to}: ${j.message || r.status}`);
      return { status: 'failed', error: j.message || `HTTP ${r.status}` };
    }
    return { status: 'sent', sid: j.sid };
  } catch (e) {
    console.error(`[sms] error to ${to}: ${e.message}`);
    return { status: 'failed', error: e.message };
  }
}

module.exports = { enabled, normalisePhone, send };
