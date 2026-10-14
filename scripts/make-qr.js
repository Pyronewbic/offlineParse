// Writes the two booth QR codes (WhatsApp chat + Wi-Fi join) to qr/. Needs `npm install` once, with internet.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../src/config.js';
import { detectAddress } from '../src/netaddr.js';
import { prefillText, whatsappLink, wifiPayload } from '../src/payloads.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config.json' },
    out: { type: 'string', default: 'qr' },
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
  whatsapp: whatsappLink(cfg.whatsappNumber, prefillText(cfg)),
  wifi: wifiPayload(cfg.wifiSsid, cfg.wifiPassword),
};
for (const [name, payload] of Object.entries(payloads)) console.log(`${name}: ${payload}`);
try {
  const { ip, how } = await detectAddress(cfg.laptopIp);
  console.log(`form fallback URL to print on the poster: http://${ip}/ (${how}; reserve this address in the router so it stays put)`);
} catch (e) {
  console.log(`form fallback URL: unknown until the laptop is on the event Wi-Fi (${e.message})`);
}

let QRCode;
try {
  QRCode = (await import('qrcode')).default;
} catch {
  console.error('qrcode is not installed; run `npm install` (needs internet once) to write the images.');
  process.exit(2);
}
mkdirSync(values.out, { recursive: true });
for (const [name, payload] of Object.entries(payloads)) {
  for (const type of ['svg', 'png']) {
    const path = join(values.out, `${name}.${type}`);
    await QRCode.toFile(path, payload, { type, errorCorrectionLevel: 'M', margin: 4, scale: 12 });
    console.log(`wrote ${path}`);
  }
}
