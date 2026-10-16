# offlineParse

On-the-spot event registration for a venue with no cell signal. Guests join an offline Wi-Fi and register (name, mobile number, consent) on a form served from a laptop; staff manage registrations on a laptop-only admin page.

## How it works

- **Wi-Fi QR:** joins a router with no internet. The router hands out the laptop's booth address as DNS, so the phone's sign-in sheet opens the registration form.
- **WhatsApp QR (optional):** opens WhatsApp with a prefilled message containing the event code; it sends once the guest has signal. Staff add these people on the admin page.
- **Storage:** everything stays on the laptop in `data/` (SQLite plus a synced spreadsheet and a log).

Node 22.13+. The server has no dependencies; `qrcode` is only for the QR scripts.

## Setup (once)

```sh
npm install   # needs internet once, for the QR scripts
npm test
```

### config.json

| Key | Meaning |
|---|---|
| `orgName` | Consent line, privacy note and the logo's alt text |
| `eventName`, `eventCode` | WhatsApp prefilled message; `eventCode` also tags each registration |
| `whatsappNumber` | For the WhatsApp QR, country code and no `+` (e.g. `919876543210`) |
| `wifiSsid`, `wifiPassword` | Must match the router; empty password = open network |
| `laptopIp` | The booth address, `"100.64.0.2"` |
| `logoLight`, `logoDark` | PNG logos for light and dark phones; empty shows `orgName` |
| `noticeVersion` | Recorded with each registration; change it when the consent wording changes |

### Router (TP-Link TL-WR845N; other routers have the same settings)

Nothing in the WAN port. Join its Wi-Fi, open `http://192.168.0.1`, then:

1. **System Tools > Password:** set a strong router admin password, different from the Wi-Fi password. Every guest can reach this page, and anyone who logs in can point the phones somewhere else.
2. **Wireless:** SSID and password as in `config.json`.
3. **Network > LAN:** IP `100.64.0.1`, mask `255.255.255.0`. Save; the router restarts, so rejoin and open `http://100.64.0.1`. (Android skips the sign-in sheet when DNS answers with a `192.168.x` address.)
4. **DHCP > DHCP Settings:** start `100.64.0.100`, end `100.64.0.199`, **Primary DNS `100.64.0.2`**, Secondary DNS `0.0.0.0`. Save.
5. Turn IPv6 off if there is a menu for it, then **System Tools > Reboot**.

From now on reach the router by `http://100.64.0.1` only; `tplinkwifi.net` will open the form instead.

### QR codes

- `npm run qr` writes `qr/wifi` and `qr/whatsapp` as `.svg` (print these; they stay sharp at any size) and `.png`.
- `npm run qr:show` draws them in the terminal to scan off the screen (if a scan fails, zoom the terminal out).

## Event day

Guests share a network with this laptop, so quit what you don't need first (dev servers, Docker or VMs, file sharing; on a Mac turn off AirPlay Receiver). Then join the booth Wi-Fi:

```sh
npm run booth-ip   # gives this laptop 100.64.0.2; asks for the admin password
npm start
```

- **Windows:** run `booth-ip` and `booth-ip:undo` in **Command Prompt** opened with **Run as administrator** (PowerShell may refuse to run npm). `booth-ip` also lets the booth network through Windows Firewall on ports 80 and 53; undo removes those rules, so the booth Wi-Fi can stay a **Public** network, which keeps Windows' other services blocked. Turn off sleep for the day.
- **macOS:** `booth-ip` switches Wi-Fi to the fixed booth address (macOS only lets a normal user answer DNS on all addresses, so it must be the only one). Allow incoming connections for `node` if asked (signed apps may be let in without asking). Keep it awake with `caffeinate -dims npm start`.
- **Linux:** ports 80 and 53 need root or `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"`; open 80/tcp and 53/udp in the firewall.
- `npm run booth-ip -- --dry-run` shows the command without running it; `--ip <address>` acts on an address other than `config.json`'s (e.g. to undo an old one). If `npm start` warns that the booth address is gone, run `npm run booth-ip` again.

**Admin:** `http://localhost/admin` on the laptop only. Newest first, search by name or any part of the number, add, delete, and **Download CSV**. Press **Refresh** for new sign-ups.

**Phone says "no internet" instead of opening the form:** run `npm start -- --verbose`, then forget and rejoin the Wi-Fi on the phone. Each DNS question and web request is printed.
- Nothing printed: the phone is not asking the laptop. Check the router's DHCP Primary DNS is `100.64.0.2` (saved, router rebooted) and the phone's Private DNS is Off or Automatic.
- `dns` lines but no `http` lines: the phone resolved to the laptop but could not connect; check the laptop firewall allows `node`.

**Do a dry run first** with [CHECKLIST.md](CHECKLIST.md), the one-page list for whoever runs the booth.

## After the event

1. Stop the server (Ctrl+C).
2. Remove the booth address: `npm run booth-ip:undo`. **Required on macOS and Windows** (Windows: as administrator), or the laptop keeps `100.64.0.2` on every network. On Linux a reboot also clears it.
3. Add anyone who registered by WhatsApp: search WhatsApp for the event code, then **Add a registration** on the admin page.

## Data

All in `data/`, readable only by your user account. Copy the folder to back up.

- `leads.db`: the source of truth.
- `leads.csv`: rewritten after every change, one row per number, sign-up time in IST. Don't open it while the booth runs (Excel on Windows locks it, and Save in any app writes back an old copy); open a **Download CSV** copy instead. If it was open, it catches up within 15 seconds of closing.
- `leads.log`: one JSON line per registration or deletion, UTC timestamps.
- A number registers once; repeats are refused.
- **Delete** on the admin page erases a person from all three files and frees the number. If a file cannot be updated, the admin page says so and the server keeps retrying, across restarts (`pending-erasures.json`). Spreadsheets already copied elsewhere are not touched.

## Other setups

- **Laptop on another network too** (tether or Ethernet for internet): give the laptop's Wi-Fi a manual DNS such as `1.1.1.1`, and put the other connection first in the network order.
- **No booth-ip:** set `laptopIp` to `"auto"` or an adapter name (`"en0"`, `"Wi-Fi"`) and point the router's DNS at that laptop's own reserved address. `npm start -- --ip <address or name>` overrides it for one run.
