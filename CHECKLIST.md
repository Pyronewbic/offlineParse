# Booth checklist

For whoever runs the booth. Commands and fixes are in the [README](README.md).

## Dry run (once, with the real router, the laptop and two phones)

- [ ] Router settings match the README's Router section; `wifiSsid` and `wifiPassword` in `config.json` match the router.
- [ ] On the booth Wi-Fi: `npm run booth-ip`, then `npm start -- --verbose`. The `DNS:` line shows `100.64.0.2` and there is no `WARNING`.
- [ ] `npm run qr`, print `qr/wifi.svg` with the text from the README under it.
- [ ] Only the booth is open to guests: `lsof -nP -iTCP -sTCP:LISTEN` (Mac) or `netstat -ano -p TCP | findstr LISTENING` (Windows) shows nothing of yours on `*` or `0.0.0.0` except node.

On each phone, forget the booth Wi-Fi, then scan the Wi-Fi QR:

- [ ] **Android:** "Sign in" appears (as a pop-up or in the notification shade), and the terminal shows `generate_204`.
- [ ] **iPhone:** the sign-in sheet opens within about 10 seconds, and the terminal shows `hotspot-detect.html`.
- [ ] Register a test name: the thank-you page shows, the name is on the admin page, the same number again is refused. Delete it.
- [ ] WhatsApp QR (if used): with mobile data off it opens a chat with the message filled in.

**Windows:** the commands run in an administrator Command Prompt ("No rules match the specified criteria" on the first run is fine); sleep is off; after `npm run booth-ip:undo`, home Wi-Fi works again.

## Event day

- [ ] Router on; laptop plugged in, on the booth Wi-Fi, with Auto-Join off for your other networks. "No internet connection" is normal.
- [ ] `npm run booth-ip`, then `npm start` (Mac: `caffeinate -dims npm start`).
- [ ] On the admin page, **New sign-ups go to** shows the bracket being played.
- [ ] One test registration from a phone, then delete it.
- [ ] Guests with no sign-in: follow the poster text (Samsung: Wi-Fi settings, the network's gear icon).
- [ ] Watch sign-ups on the admin page; for a spreadsheet use **Download CSV**, never `data/leads.csv`.
- [ ] If the terminal warns the booth address is gone, run `npm run booth-ip` again.

## After the event

- [ ] Stop the server (Ctrl+C), then `npm run booth-ip:undo`.
- [ ] **Download CSV** and copy `data/` somewhere safe.
- [ ] Add anyone who registered by WhatsApp on the admin page.
