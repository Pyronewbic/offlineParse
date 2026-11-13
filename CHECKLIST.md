# Booth checklist

For whoever runs the booth. Commands and fixes are in the [README](README.md); running the LCQ tablet is in [LCQ.md](LCQ.md).

## Dry run (once, with the real router, the laptop and two phones)

- [ ] Router settings match the README's Router section; `wifiSsid` and `wifiPassword` in `config.json` match the router.
- [ ] Only with `routerBan` on: one phone registers on the form and drops off the Wi-Fi after `afterMin` minutes and cannot rejoin; the LCQ tablet stays on; **Back on Wi-Fi** lets the phone rejoin.
- [ ] On the booth Wi-Fi: `npm run booth-ip`, then `npm start -- --verbose`. The `DNS:` line shows `100.64.0.2` and there is no `WARNING`.
- [ ] `npm run qr`, print `qr/wifi.svg` with the text from the README under it.
- [ ] Only the booth is open to guests: `lsof -nP -iTCP -sTCP:LISTEN` (Mac) or `netstat -ano -p TCP | findstr LISTENING` (Windows) shows nothing of yours on `*` or `0.0.0.0` except node.

On each phone, forget the booth Wi-Fi, then scan the Wi-Fi QR:

- [ ] **Android:** "Sign in" appears (as a pop-up or in the notification shade), and the terminal shows `generate_204`.
- [ ] **iPhone:** the sign-in sheet opens within about 10 seconds, and the terminal shows `hotspot-detect.html`.
- [ ] Register a test name: the thank-you page shows, the name is on the admin page, the same number again is refused. Delete it.
- [ ] LCQ tablet: join the booth Wi-Fi and stay on it (if a sign-in sheet appears, do not tap Cancel; choose to stay connected or use without internet), open the runner address, enter the PIN, and check it is still connected and updating after 15 minutes.

**Windows:** the commands run in an administrator Command Prompt ("No rules match the specified criteria" on the first run is fine); sleep is off; after `npm run booth-ip:undo`, home Wi-Fi works again.

## Event day

- [ ] Router on; laptop plugged in, on the booth Wi-Fi, with Auto-Join off for your other networks. "No internet connection" is normal.
- [ ] `npm run booth-ip`, then `npm start` (Mac: `caffeinate -dims npm start`).
- [ ] On the admin page, **Start a new event** for today (unless it is already the one marked (now)), so today's sign-ups and LCQ are kept apart.
- [ ] **New sign-ups go to** shows the bracket being played; the LCQ tablet is on the runner page.
- [ ] LCQ, per game ([LCQ.md](LCQ.md)): **LCQ Finalize** when its sign-ups close, **LCQ End** when it is done.
- [ ] One test registration from a phone, then delete it.
- [ ] Guests with no sign-in: follow the poster text (Samsung: Wi-Fi settings, the network's gear icon).
- [ ] Watch sign-ups on the admin page; for a spreadsheet use **Download CSV**, never `data/leads.csv`.
- [ ] If the terminal warns the booth address is gone, run `npm run booth-ip` again.

## After the event

- [ ] Stop the server (Ctrl+C), then `npm run booth-ip:undo`.
- [ ] **Download CSV** and copy `data/` somewhere safe.
