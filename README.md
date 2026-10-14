# offlineParse

Lead capture for a booth with no cell signal. Two ways in, one lead list:

1. **WhatsApp QR (main).** Opens WhatsApp with a prefilled "Hi, I'm at <event> (<code>). My name is:" message to our number. WhatsApp holds the message until the guest gets signal, then it arrives with their real number. A staff member replies with the socials and adds them in the admin page.
2. **Wi-Fi QR (fallback).** Joins an offline router. Every DNS name points at this laptop, so the phone's sign-in sheet opens our form (name, WhatsApp number, consent). Leads are stored in SQLite on the laptop. A staff-held tablet on the same Wi-Fi can use the same form.

After the event, the admin page has an **Open WhatsApp** button per lead that opens a chat with the socials message prefilled (WhatsApp Desktop or Web on the laptop), and **Mark sent** to track it.

Needs Node 22.13+ (built-in `node:sqlite`). The server has no dependencies; `qrcode` is only for generating the images.

## Before the event (needs internet once)

```sh
npm install          # only for the QR script
npm test
```

Edit `config.json`: org and event names, `eventCode` (shows up in WhatsApp messages so you can tell events apart), `whatsappNumber` (country code, no `+`), the real social links, and `wifiSsid` / `wifiPassword` (empty password = open network).

### Router

The router must have **no internet** (nothing in the WAN port).

1. Set the SSID (and password if any) to match `config.json`.
2. Give the laptop a fixed IP with a DHCP reservation. Put it in `laptopIp` (`ipconfig getifaddr en0` while joined).
3. In the router's DHCP settings, set the **DNS server handed to clients** to `laptopIp`. This makes the sign-in sheet pop up. If the router can't do this, the form still works at the printed URL, it just won't pop up.

Then `npm run qr` writes `qr/whatsapp.{svg,png}` and `qr/wifi.{svg,png}` and prints the fallback URL for the poster.

### Test on real phones (one iPhone, one Android)

These behaviours could not be confirmed from documentation; check them before relying on them:

1. With mobile data and Wi-Fi off, scan the WhatsApp QR with the stock camera. Does WhatsApp open with the text? Tap send, then turn data back on **without reopening WhatsApp**. Does the message arrive? If iPhones only send once WhatsApp is reopened, add "open WhatsApp once you have signal" to the poster.
2. Join the booth Wi-Fi. Does the sign-in sheet open by itself? Submit the form, then disconnect.
3. On the laptop, click **Open WhatsApp** in the admin page and confirm the chat opens prefilled.

## Event day

```sh
caffeinate -dims npm start
```

macOS may ask to allow incoming connections for `node`: allow it. Ports 80 and 53 do not need `sudo` on current macOS. The server refuses to start if `laptopIp` is not this machine's address.

- Form: `http://<laptopIp>/` (print this on the poster as a fallback)
- Admin, from the laptop only: `http://localhost/admin` (returns 404 to anyone on the Wi-Fi)
- Data: `data/leads.db` (WAL mode; copy the whole `data/` folder to back up). **Download CSV** on the admin page exports everything.

## After the event

- WhatsApp QR leads: reply with the message from the admin page's text box, then add them with **Add someone who messaged us**.
- Form leads: **Open WhatsApp**, send, **Mark sent**.
- Leads are de-duplicated by phone number, so someone who did both appears once.
- Sending to many new chats from a regular WhatsApp account can get it flagged for spam. Keep batches modest; everyone on the list opted in, which helps.
- Honour STOP replies by deleting the row; the form and messages promise this.

## Phase 2: automated sends

Planned: WhatsApp Cloud API. A guest's own message opens a 24-hour window in which a free-form reply is currently free (re-check Meta's rate card), so the WhatsApp QR path can auto-reply. Form leads need an approved marketing template, which is a paid send. `socialsSentAt` and `source` in the `leads` table are where that work plugs in.
