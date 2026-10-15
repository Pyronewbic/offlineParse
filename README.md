# offlineParse

Lead capture for a booth with no cell signal. Two ways in, one lead list:

1. **WhatsApp QR (main).** Opens WhatsApp with a prefilled "Hi, I'm at <event> (<code>). My name is:" message to our number. WhatsApp holds the message until the guest gets signal, then it arrives with their real number. A staff member adds them in the admin page.
2. **Wi-Fi QR (fallback).** Joins an offline router. Every DNS name points at this laptop, so the phone's sign-in sheet opens our registration form (name, mobile number, consent). Leads are stored in SQLite on the laptop. A staff-held tablet on the same Wi-Fi can use the same form.

The admin page on the laptop lists every registration with its sign-up time in India time, and downloads them all as a spreadsheet.

Needs Node 22.13+ (built-in `node:sqlite`). The server has no dependencies; `qrcode` is only for generating the images.

## Before the event (needs internet once)

```sh
npm install          # only for the QR script
npm test
```

Edit `config.json`: org name (shown in the consent line and WhatsApp messages; the logo replaces it as the page heading), event name, `eventCode` (shows up in WhatsApp messages so you can tell events apart), `whatsappNumber` (country code, no `+`), and `wifiSsid` / `wifiPassword` (empty password = open network). `logoLight` / `logoDark` point at PNG logos for light and dark phones (checked at startup; empty shows the org name instead).

### Router (once)

The router must have **no internet** (nothing in the WAN port). Menu names below are from a TP-Link TL-WR845N; other routers have the same settings under similar names.

1. **Network > LAN:** leave the router at its default address, `192.168.0.1` (its admin page; join its Wi-Fi first).
2. **Wireless:** SSID and password to match `config.json`.
3. **DHCP > DHCP Settings:** start `192.168.0.100`, end `192.168.0.199` (keeps the booth address `.2` out of the pool), **Primary DNS `192.168.0.2`**, Secondary DNS `0.0.0.0`. Save.
4. Turn IPv6 off if the router has it, then **System Tools > Reboot**.

That is all the router ever needs: no per-laptop reservation. Whichever laptop runs the booth takes the booth address, `laptopIp` in `config.json` (`"192.168.0.2"`), with `npm run booth-ip` (see Event day). Every phone asks that address for DNS, which makes the sign-in sheet open the form.

`laptopIp` can instead be `"auto"` or an adapter name such as `"en0"` / `"Wi-Fi"`, for a setup where the router's DNS points at one particular laptop's own address; `npm start -- --ip <address or name>` overrides it for one run.

### Internet on the laptop during the event (optional)

Nothing needs internet. If you want it anyway, keep Wi-Fi on the event router and add a second connection: USB tethering from a phone with signal, or Ethernet.

- Give the laptop's own Wi-Fi a manual DNS server such as `1.1.1.1`, or exclude the laptop from the router's DNS setting. Otherwise the laptop asks its own catch-all DNS for every website and gets nowhere.
- Put the tether or Ethernet above Wi-Fi in the network order (macOS: Network settings, Set Service Order; Windows does this automatically; Linux: lower route metric) so internet traffic leaves that way. Traffic to the booth Wi-Fi's own address range still uses Wi-Fi.

Then `npm run qr` writes `qr/whatsapp.{svg,png}` and `qr/wifi.{svg,png}` and prints the fallback URL for the poster. `npm run qr:show` draws both codes in the terminal instead, to scan straight off the laptop screen (if a scan fails, zoom the terminal out or reduce its line spacing).

### Test on real phones (one iPhone, one Android)

These behaviours could not be confirmed from documentation; check them before relying on them:

1. With mobile data and Wi-Fi off, scan the WhatsApp QR with the stock camera. Does WhatsApp open with the text? Tap send, then turn data back on **without reopening WhatsApp**. Does the message arrive? If iPhones only send once WhatsApp is reopened, add "open WhatsApp once you have signal" to the poster.
2. Join the booth Wi-Fi. Does the sign-in sheet open by itself? Submit the form, then disconnect.

## Event day

Join the booth Wi-Fi, then:

```sh
npm run booth-ip   # gives this laptop 192.168.0.2; asks for the admin password
npm start
```

- **macOS / Linux:** the booth address is temporary and disappears on reboot or Wi-Fi reconnect, so nothing needs undoing. If the laptop reconnects mid-event, `npm start` starts warning; run `npm run booth-ip` again.
- **Windows:** run both in a terminal opened with **Run as administrator**. Windows cannot add a second address to an automatic adapter, so the Wi-Fi adapter is switched to the booth address. **After the event run `npm run booth-ip -- --undo`** (as administrator), or the laptop stays on that address on every network.
- `npm run booth-ip -- --dry-run` prints the exact command without running it.

Keep the laptop awake and plugged in (macOS: `caffeinate -dims npm start`). The server re-checks its address every 5 seconds and warns if the booth address goes away.

- **macOS:** allow incoming connections for `node` when asked. Ports 80 and 53 need no `sudo`.
- **Windows:** allow Node.js through the firewall when asked, and set the event Wi-Fi to a **Private** network (Windows blocks incoming connections on Public ones). Ports 80 and 53 need no admin rights.
- **Linux:** ports below 1024 need root, or once: `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"`. Allow 80/tcp and 53/udp in the firewall (for example `ufw`). The DNS helper listens only on the booth address, so systemd-resolved holding port 53 on loopback does not conflict.

- Form: `http://192.168.0.2/` (print this on the poster as a fallback)
- Admin, from the laptop only: `http://localhost/admin` (returns 404 to anyone on the Wi-Fi). Newest registrations first, totals by source, search by name or any part of the number, manual add, and per-row delete. Use **Refresh** to see new sign-ups; it does not auto-refresh, so typing is never wiped.
- Data, all in `data/` and readable only by your user account (copy the whole folder to back up):
  - `leads.db`: the source of truth (SQLite).
  - `leads.csv`: opens in Excel or Numbers. Rewritten after every sign-up and admin add, so it always matches the database (one row per phone number). Excel does not refresh an open file: reopen it, or use the admin page for a live view. Rebuilt on startup if deleted.
  - `leads.log`: append-only, one JSON line per registration (`lead.created`) or deletion (`lead.deleted`, id only), with UTC timestamps. Only ever appended to, except when a registration is deleted.
  - If the CSV or log cannot be written, sign-ups still save to the database and the admin page shows a red warning.

## After the event

- WhatsApp QR registrations: search WhatsApp for the event code to find them, then add each one with **Add someone who messaged us**.
- A phone number can register only once. A second attempt, on the form or the admin page, is refused with an error and the first registration is left as it was.
- Deletion requests (the form promises them): use **Delete** next to the person on the admin page and confirm. It removes them from the database (overwriting the old bytes), the spreadsheet and the log, and frees the number to register again. Spreadsheets already downloaded or copied elsewhere are not touched.
