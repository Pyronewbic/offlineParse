/** Replace {key} placeholders in a single pass; values are never re-expanded. {{ and }} are literal braces. */
export function fill(template, values) {
  return template.replace(/\{\{|\}\}|\{([A-Za-z]\w*)\}/g, (match, key) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (!Object.hasOwn(values, key)) throw new Error(`unknown placeholder {${key}}`);
    return String(values[key]);
  });
}

export function whatsappLink(numberDigits, text = '') {
  const link = `https://wa.me/${numberDigits}`;
  return text ? `${link}?text=${encodeURIComponent(text)}` : link;
}

function wifiEscape(value) {
  return value.replace(/[\\;,:"]/g, (ch) => `\\${ch}`);
}

export function wifiPayload(ssid, password) {
  return password
    ? `WIFI:T:WPA;S:${wifiEscape(ssid)};P:${wifiEscape(password)};;`
    : `WIFI:T:nopass;S:${wifiEscape(ssid)};;`;
}

export function prefillText(cfg) {
  return fill(cfg.prefillMessage, { orgName: cfg.orgName, eventName: cfg.eventName, eventCode: cfg.eventCode });
}

export function socialsText(cfg, name) {
  return fill(cfg.socialsMessage, { name, orgName: cfg.orgName, eventName: cfg.eventName, ...cfg.socials });
}
