# Booth checklist

For whoever runs the booth. Commands and fixes are in the [README](README.md).

## Dry run (once, with the real router, the laptop and two phones)

- [ ] Router set up as in the README: LAN `100.64.0.1`, DHCP Primary DNS `100.64.0.2`, rebooted, nothing in the WAN port.
- [ ] `config.json`: `wifiSsid` and `wifiPassword` match the router, `laptopIp` is `"100.64.0.2"`.
- [ ] Laptop on the booth Wi-Fi: `npm run booth-ip`, then `npm start -- --verbose`. The `DNS:` line shows `100.64.0.2` and there are no `WARNING` lines.
- [ ] `npm run qr` and print `qr/wifi.png` (and `qr/whatsapp.png` if used). Delete any old `qr/register.*` files.

On each phone, forget the booth Wi-Fi first, then scan the Wi-Fi QR with the camera:

- [ ] **Android:** "Sign in to Wi-Fi network" appears with no "no internet" question. The terminal shows `connectivitycheck.gstatic.com/generate_204`.
- [ ] **iPhone** (iOS 26, plus an older iOS if you can): the sign-in sheet opens within about 10 seconds. The terminal shows `captive.apple.com/hotspot-detect.html`.
- [ ] Register a test name: the thank-you page shows, the name is on `http://localhost/admin`, and the same number a second time is refused. Delete the test entry.
- [ ] iPhone: the sheet only offers **Cancel**, which Apple says leaves the Wi-Fi. Try it after registering and note what happens, so desk staff know what to tell guests.
- [ ] iPhone with iCloud Private Relay on: an alert about Private Relay may appear; the form should still open.
- [ ] If you use the WhatsApp QR: with mobile data off it still opens a chat with the message filled in.
- [ ] If the sheet does not open, follow "Phone says no internet" in the README.

**Windows laptop:**

- [ ] `booth-ip` and `booth-ip:undo` run in Command Prompt opened with **Run as administrator**. "No rules match the specified criteria" on the first run is expected.
- [ ] `npm start` runs in a normal Command Prompt. If it says a port is taken, do what the message says.
- [ ] Sleep is off while plugged in (Settings, System, Power).
- [ ] After `npm run booth-ip:undo`, `ipconfig /all` shows DHCP Enabled as Yes for the Wi-Fi, and home Wi-Fi works again.

**Mac laptop:** run `caffeinate -dims npm start` so it stays awake.

## Event day

- [ ] Router on, laptop plugged in and on the booth Wi-Fi.
- [ ] `npm run booth-ip`, then `npm start`.
- [ ] One test registration from a phone, then delete it on the admin page.
- [ ] Watch sign-ups on the admin page. For a spreadsheet, use **Download CSV** and open that copy, never `data/leads.csv` itself.
- [ ] Glance at the terminal now and then: if it warns the booth address is gone, run `npm run booth-ip` again.

## After the event

- [ ] Stop the server (Ctrl+C), then `npm run booth-ip:undo` (required on macOS and Windows).
- [ ] **Download CSV** on the admin page and copy the `data/` folder somewhere safe.
- [ ] Add anyone who registered by WhatsApp on the admin page.
