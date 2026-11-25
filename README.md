# QR Queue

A walk-in queue that customers join by scanning a QR code with their phone. No app to install.

| Page | Who uses it | What it does |
|---|---|---|
| `/display` | Screen or tablet facing customers | Shows the QR code, the number being served and how many people are waiting. Chimes when a number is called (click the page once to enable sound). |
| `/join` | Customer's phone (opened from the QR code) | First and last name, email, mobile number, track and transmission, then a ticket. |
| `/t/<id>` | Customer's phone | Live position and estimated wait. When it's their turn, the screen turns yellow, the phone vibrates, it beeps and it can send a notification. |
| `/admin` | Staff (PIN protected) | "Call next", call a specific person, recall, done, no-show, remove, put back, open or close the queue, reset numbering. |

## Run it

```bash
npm install
ADMIN_PIN=4821 npm start
```

Open `http://localhost:3000/display` on the screen and `http://localhost:3000/admin` on the staff device.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PIN` | `1234` | Staff PIN. **Change this.** |
| `QUEUE_NAME` | `Rentertainment F1 Simulator` | Name shown on every page |
| `PUBLIC_URL` | auto | URL put in the QR code, e.g. `https://queue.mybusiness.com`. When it isn't set, the QR code uses this machine's LAN IP, so phones on the same Wi-Fi can join. |
| `TWILIO_ACCOUNT_SID` | – | Twilio account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | – | Twilio auth token. Keep this secret. |
| `TWILIO_FROM` | – | Your Twilio phone number (e.g. `+614…`) or an approved alphanumeric sender ID |
| `PORT` | `3000` | |
| `DATA_FILE` | `./data.json` | Where the queue is saved, so it survives restarts |

## Text messages

Customers get up to three texts:

1. **"You're next!"** when they move to the front of the queue. No text if they were already first when they joined, because their screen says so.
2. **"It's your turn! Please go to Sim 1"** when staff call them.
3. **"Reminder…"** if staff press 🔔 Recall.

Texts are sent through [Twilio](https://www.twilio.com). Create an account, buy an Australian number (or register a sender ID), then set the three `TWILIO_*` variables. When they aren't set, the app still works: texts are printed to the server log and the staff console shows a "Text messages are off" banner. Each person's row on the staff console shows whether each text was sent or failed.

People pick their country code from a dropdown (🇦🇺 +61 by default) and type their number as they normally would. A leading 0 is dropped automatically, so `0412 345 678` becomes `+61412345678`. Australian numbers must be mobiles (04…). To add a country, add an `<option>` to the dropdown in `public/join.html`. To include a live-status link in the "You're next" text, set `PUBLIC_URL`.

## Going live

Phones on mobile data can't reach a laptop's LAN address. For real customers, deploy to any Node host (Render, Railway, Fly.io, a VPS) with a persistent disk for `data.json`, then set `PUBLIC_URL`. HTTPS is needed for phone notifications. Vibration and on-page alerts work without it.

## How it works

- Express server. All state is in memory and written to `data.json`.
- Live updates use Server-Sent Events (`/events`). Every page updates instantly with no polling.
- Ticket links contain a random 96-bit ID, so customers can't cancel each other's tickets.
- The estimated wait is the average time between the last 10 calls (3 minutes until there's enough data).
- Each phone remembers its ticket, so scanning the QR code again goes back to the existing ticket instead of creating a duplicate.
