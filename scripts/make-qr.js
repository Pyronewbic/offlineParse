// Writes the two booth QR codes (Wi-Fi join + WhatsApp chat) to qr/, or with --terminal draws them in the
// terminal to scan straight off the screen. Needs `npm install` once, with internet.
import { mkdirSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../src/config.js';
import { detectAddress } from '../src/netaddr.js';
import { prefillText, whatsappLink, wifiPayload } from '../src/payloads.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    out: { type: 'string', default: 'qr' },
    terminal: { type: 'boolean', default: false },
  },
});

let cfg;
try {
  cfg = loadConfig(values.config);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(2);
}

const payloads = {
  wifi: wifiPayload(cfg.wifiSsid, cfg.wifiPassword),
  whatsapp: whatsappLink(cfg.whatsappNumber, prefillText(cfg)),
};
const labels = {
  wifi: `Wi-Fi: join "${cfg.wifiSsid}"${cfg.wifiPassword ? '' : ' (open network)'}`,
  whatsapp: `WhatsApp: message ${cfg.orgName}`,
};
if (!values.terminal) for (const [name, payload] of Object.entries(payloads)) console.log(`${name}: ${payload}`);
if (isIPv4(cfg.laptopIp)) {
  console.log(`form fallback URL to print on the poster: http://${cfg.laptopIp}/ (the booth address)`);
} else {
  try {
    const { ip, how } = await detectAddress(cfg.laptopIp);
    console.log(`form fallback URL to print on the poster: http://${ip}/ (${how}; reserve this address in the router so it stays put)`);
  } catch (e) {
    console.log(`form fallback URL: unknown until the laptop is on the event Wi-Fi (${e.message})`);
  }
}

let QRCode;
try {
  QRCode = (await import('qrcode')).default;
} catch {
  console.error('qrcode is not installed; run `npm install` (needs internet once) to write the images.');
  process.exit(2);
}
if (values.terminal) {
  for (const name of Object.keys(payloads)) {
    console.log(`\n${labels[name]}`);
    console.log(await QRCode.toString(payloads[name], { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
  }
  process.exit(0);
}
mkdirSync(values.out, { recursive: true });
for (const [name, payload] of Object.entries(payloads)) {
  for (const type of ['svg', 'png']) {
    const path = join(values.out, `${name}.${type}`);
    await QRCode.toFile(path, payload, { type, errorCorrectionLevel: 'M', margin: 4, scale: 12 });
    console.log(`wrote ${path}`);
  }
}
