# offlineParse

On-the-spot event registration where there is no cell signal. Guests join an offline Wi-Fi and register (name, mobile number, email, consent) on a form served from a laptop; staff manage registrations on a laptop-only admin page.

- **Wi-Fi QR:** joins a router with no internet whose DNS is the laptop, so phones open the form as a sign-in page.
- **At the desk:** staff can also register someone on the admin page, after reading them the consent line.
- **Storage:** stays on the laptop in `data/`.

Node 22.13+. The server has no dependencies; `qrcode` is only for the QR scripts. Before an event, do a dry run with [CHECKLIST.md](CHECKLIST.md).

## Setup (once)

```sh
npm install   # needs internet once
npm test
npm run try         # the whole booth on this laptop, no router, data in data/try/ (see below)
npm run try:check   # with try running: checks DNS, sign-in, sign-up, desk and tablet; deletes its test sign-up
```

**Practice on this laptop:** with `npm run try` running, open the phone form at `http://127.0.0.1/`, the desk at `http://localhost/admin` and the tablet runner at `http://127.0.0.1/lcq` (PIN on the desk page). Its DNS answers on port 5300 instead of 53, so it does not clash with anything else on this laptop.

### config.json

| Key | Meaning |
|---|---|
| `orgName` | Consent line, privacy note and the logo's alt text |
| `eventName`, `eventCode` | The first event; start later ones on the admin page |
| `wifiSsid`, `wifiPassword` | Must match the router; empty password = open network |
| `laptopIp` | The booth address, `"100.64.0.2"` |
| `logoLight`, `logoDark` | PNG logos for light and dark phones; empty shows `orgName` |
| `games` | Games guests can tick, e.g. `["SSBU", "SF6"]`; each ticked game is its own registration. Leave out for no game question |
| `noticeVersion` | Recorded with each registration; change it when the consent wording changes |
| `lcqWaitAlertMin`, `lcqMatchAlertMin` | Optional: the runner flags a player waiting this many minutes for a match (default 10) or a match running this long (default 15) |

### Router (TP-Link TL-WR845N)

Already set up. Admin page `http://100.64.0.1` (not `tplinkwifi.net`, which opens the form). **DHCP > DHCP Settings** must have the pool `100.64.0.10` to `100.64.0.250` and a lease time of `10` minutes; a longer lease runs out of addresses at about 100 guests. If phones stop getting the sign-in page, **DHCP > DHCP Clients List** shows how many are taken, and **System Tools > Reboot** clears them.

<details>
<summary>Setting up a router from scratch</summary>

Nothing in the WAN port. Join its Wi-Fi, open `http://192.168.0.1`, then:

1. **System Tools > Password:** a strong admin password, not the Wi-Fi one (every guest can reach this page).
2. **Wireless:** SSID and password as in `config.json`.
3. **Network > LAN:** IP `100.64.0.1`, mask `255.255.255.0`. Save, rejoin, open `http://100.64.0.1`. (Android skips the sign-in page with `192.168.x`.)
4. **DHCP > DHCP Settings:** start `100.64.0.10`, end `100.64.0.250`, lease `10` minutes, Primary DNS `100.64.0.2`, Secondary DNS `0.0.0.0`.
5. IPv6 off if there is a menu for it, then **System Tools > Reboot**.

</details>

### QR codes

`npm run qr` writes `qr/wifi` (print the `.svg`); `npm run qr:show` draws it in the terminal. Print under it:

> **Scan to join, then tap "Sign in"** (pull down from the top of the screen if it does not pop up).
> Nothing? Turn off mobile data, then open **http://100.64.0.2**
> iPhone: register first, then tap Cancel to leave.

## Event day

Quit what you don't need (dev servers, Docker or VMs, file sharing, AirPlay Receiver): guests share a network with the laptop. Join the booth Wi-Fi, then:

```sh
npm run booth-ip   # gives this laptop 100.64.0.2; asks for the admin password
npm start
```

- **Windows:** run `booth-ip` and `booth-ip:undo` in Command Prompt opened with **Run as administrator**. They add and remove the Windows Firewall rules, so the booth Wi-Fi can stay a Public network.
- **macOS:** allow incoming connections for `node` if asked; keep it awake with `caffeinate -dims npm start`.
- **Linux:** ports below 1024 need root or `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(command -v node)")"`; open 80, 443 and 853/tcp and 53/udp in the firewall.
- `npm run booth-ip -- --dry-run` shows the command; `--ip <address>` acts on another address. If `npm start` warns the booth address is gone, run `npm run booth-ip` again.

**Admin:** `http://localhost/admin`, on the laptop only. **New sign-ups go to** switches the bracket (Normal or LCQ) every new registration joins; the All / Normal / LCQ tabs and the game filter split the list, and **Download CSV** exports what you're looking at. **Event** lists every event; pick an earlier one to view or download it. **Start a new event** sends new sign-ups to a new event straight away, with a fresh LCQ runner. Also search, add, delete, **Refresh** for new sign-ups.

**LCQ runner:** on a tablet on the booth Wi-Fi, open the address and PIN shown on the admin page (`http://100.64.0.2/lcq`). Each game has its own tab. The LCQ is single elimination.

1. **Play.** A sign-up can play at once. Ready to play lists the pairs on the same wins, longest waiting first (past four, the rest fold under **N more pairs**): tap **Start**, then the winner (A or B). The result shows at the top with **Undo** until the next change. **Pick a match** pairs any two yourself (Against lists the same wins; tick **Any wins** for everyone).
2. **Fill the bracket.** It runs out evenly at a power of 2, so the tab says how many more make it full (24 in: need 8 more for 32).
3. **LCQ Finalize** fixes who is in (a tick if it is not full). Later sign-ups are told the bracket is full and counted on the tab; **LCQ Unfinalize** lets them in.
4. **Bye.** Once finalized, a player alone on their wins with nobody below to catch up gets a **Bye** in Needs attention: one win, no match, undoable.
5. **LCQ End** (bottom of the tab) shows the Winner (most wins still in), makes the tab read-only and marks the game "(LCQ ended)" on the guest form. **Reopen** undoes it.

**Rounds** (folded during play, open once ended) draws the bracket start.gg style: a column per round, each match with its winner, and a line from each winner to the match they played next (or to where they are waiting). Once finalized each round says how many matches are still to come, and the last one in shows as the Winner.

**Event** at the top picks an earlier event to look back at its results and winners; only the current event can be run.

**Needs attention** lists long waits and long matches; **Find a player** searches by name or number; **Standings** counts matches on, waiting and eliminated, with each free player's wait (a long one may mean they left). Tap a name for their number and **Drop** (tick "not here" first), which gives their match to the opponent. The tablet stays signed in until the server restarts.

**A phone gets no sign-in page:** run `npm start -- --verbose` and rejoin from the phone; each DNS question and web request is printed.
- Nothing printed: the phone is not asking the laptop. A `169.254` address or none on the phone means the router's addresses ran out (see Router). Otherwise check the router's Primary DNS and that the phone's Private DNS is Off or Automatic.
- `dns` lines but no `http` lines: check the laptop firewall allows `node`.

## After the event

Stop the server (Ctrl+C), then run `npm run booth-ip:undo`. This is required on macOS and Windows, or the laptop keeps `100.64.0.2` on every network.

## Data

All in `data/`, owner-only on macOS and Linux; copy the folder to back up. On a Mac `npm start` keeps it out of Time Machine; on Windows keep the repo out of OneDrive and File History.

- `leads.db`: the source of truth. A number registers once per game and bracket in each event. Email is required from 2026-11 (`noticeVersion` `2026-11-v2`); earlier rows have none. The LCQ tablet never shows it.
- `leads.csv`: rewritten after every change, times in IST. Don't open it while the booth runs; open a **Download CSV** copy.
- `leads.log`: one JSON line per registration or deletion, UTC.
- **Delete** on the admin page erases a person from all three and frees the number; if a file can't be updated yet, the admin page says so and it is retried. Copies made elsewhere are not touched.

## Other setups

- **Laptop also online** (tether or Ethernet): give its Wi-Fi a manual DNS such as `1.1.1.1` and put the other connection first.
- **No booth-ip:** set `laptopIp` to `"auto"` or an adapter name (`"en0"`, `"Wi-Fi"`) reserve that laptop's address in the router and make it the router's Primary DNS. `npm start -- --ip <address or name>` overrides it for one run.
