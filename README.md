# offlineParse

Lead capture for a booth with no cell signal. Two ways in, one lead list:

1. **WhatsApp QR (main).** Opens WhatsApp with a prefilled "Hi, I'm at <event> (<code>). My name is:" message to our number. WhatsApp holds the message until the guest gets signal, then it arrives with their real number. A staff member replies with the socials and adds them in the admin page.
2. **Wi-Fi QR (fallback).** Joins an offline router. Every DNS name points at this laptop, so the phone's sign-in sheet opens our registration form (name, mobile number, consent). Leads are stored in SQLite on the laptop. A staff-held tablet on the same Wi-Fi can use the same form.

After the event, the admin page has an **Open WhatsApp** button per lead that opens a chat with the socials message prefilled (WhatsApp Desktop or Web on the laptop), and **Mark sent** to track it.

Needs Node 22.13+ (built-in `node:sqlite`). The server has no dependencies; `qrcode` is only for generating the images.

## Before the event (needs internet once)

```sh
npm install          # only for the QR script
npm test
```

Edit `config.json`: org name (shown in the consent line and WhatsApp messages; the logo replaces it as the page heading), event name, `eventCode` (shows up in WhatsApp messages so you can tell events apart), `whatsappNumber` (country code, no `+`), the real social links, and `wifiSsid` / `wifiPassword` (empty password = open network). `logoLight` / `logoDark` point at PNG logos for light and dark phones (checked at startup; empty shows the org name instead).

### Router

The router must have **no internet** (nothing in the WAN port).

1. Set the SSID (and password if any) to match `config.json`.
2. Join the laptop to it and run `npm start`; the first line shows the address it picked. Reserve that address for the laptop in the router (DHCP reservation) so the poster URL stays valid.
3. In the router's DHCP settings, set the **DNS server handed to clients** to that address, and nothing else. This makes the sign-in sheet pop up. If the router can't do this, the form still works at the printed URL, it just won't pop up.
4. Turn off IPv6 on the router (or its IPv6 DNS advertisement); otherwise phones can ask the router's IPv6 DNS and skip the laptop.

`laptopIp` is `"auto"` by default, which works when the laptop is on exactly one network: it uses that network's address, ignoring loopback, link-local and virtual adapters (Docker, WSL/Hyper-V, VirtualBox, VMware, VPNs). On two or more networks it refuses to guess and lists them, marking the default route (usually the internet one). Then set `laptopIp` to the event Wi-Fi adapter's name, which keeps working if its address changes: `"en0"` on most Macs, `"Wi-Fi"` on Windows, `"wlan0"` or similar on Linux. A fixed address also works. `npm start -- --ip <name or address>` overrides it for one run.

### Internet on the laptop during the event (optional)

Nothing needs internet until you send the socials. If you want it anyway, keep Wi-Fi on the event router and add a second connection: USB tethering from a phone with signal, or Ethernet.

- Set `laptopIp` to the Wi-Fi adapter name (see above); `"auto"` will refuse because there are now two networks.
- Give the laptop's own Wi-Fi a manual DNS server such as `1.1.1.1`, or exclude the laptop from the router's DNS setting. Otherwise the laptop asks its own catch-all DNS for every website and gets nowhere.
- Put the tether or Ethernet above Wi-Fi in the network order (macOS: Network settings, Set Service Order; Windows does this automatically; Linux: lower route metric) so internet traffic leaves that way. Traffic to the booth Wi-Fi's own address range still uses Wi-Fi.

Then `npm run qr` writes `qr/whatsapp.{svg,png}` and `qr/wifi.{svg,png}` and prints the fallback URL for the poster.

### Test on real phones (one iPhone, one Android)

These behaviours could not be confirmed from documentation; check them before relying on them:

1. With mobile data and Wi-Fi off, scan the WhatsApp QR with the stock camera. Does WhatsApp open with the text? Tap send, then turn data back on **without reopening WhatsApp**. Does the message arrive? If iPhones only send once WhatsApp is reopened, add "open WhatsApp once you have signal" to the poster.
2. Join the booth Wi-Fi. Does the sign-in sheet open by itself? Submit the form, then disconnect.
3. On the laptop, click **Open WhatsApp** in the admin page and confirm the chat opens prefilled.

## Event day

```sh
npm start
```

Keep the laptop awake and plugged in (macOS: `caffeinate -dims npm start`). The server re-checks its address every 5 seconds: with `"auto"` it follows a changed address (and says so), with a fixed `laptopIp` it prints a warning until the address is back.

- **macOS:** allow incoming connections for `node` when asked. Ports 80 and 53 need no `sudo`.
- **Windows:** allow Node.js through the firewall when asked, and set the event Wi-Fi to a **Private** network (Windows blocks incoming connections on Public ones). Ports 80 and 53 need no admin rights.
- **Linux:** ports below 1024 need root, or once: `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"`. Allow 80/tcp and 53/udp in the firewall (for example `ufw`). If systemd-resolved already holds port 53 on loopback, the DNS helper binds to the Wi-Fi address instead, automatically.

- Form: `http://<laptop address>/` (print this on the poster as a fallback)
- Admin, from the laptop only: `http://localhost/admin` (returns 404 to anyone on the Wi-Fi)
- Data, all in `data/` and readable only by your user account (copy the whole folder to back up):
  - `leads.db`: the source of truth (SQLite).
  - `leads.csv`: opens in Excel or Numbers. Rewritten after every sign-up, admin add, and Mark sent, so it always matches the database (one row per phone number). Excel does not refresh an open file: reopen it, or use the admin page for a live view. Rebuilt on startup if deleted.
  - `leads.log`: append-only, one JSON line per event (`lead.created`, `lead.updated`, `socials.sent`). Never rewritten, so it keeps every submission, including repeats.
  - If the CSV or log cannot be written, sign-ups still save to the database and the admin page shows a red warning.

## After the event

- WhatsApp QR leads: reply with the message from the admin page's text box, then add them with **Add someone who messaged us**.
- Form leads: **Open WhatsApp**, send, **Mark sent**.
- Leads are de-duplicated by phone number, so someone who did both appears once.
- Sending to many new chats from a regular WhatsApp account can get it flagged for spam. Keep batches modest; everyone on the list opted in, which helps.
- Honour deletion requests by deleting the row; the form promises this.
