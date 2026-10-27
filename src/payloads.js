function wifiEscape(value) {
  return value.replace(/[\\;,:"]/g, (ch) => `\\${ch}`);
}

export function wifiPayload(ssid, password) {
  return password
    ? `WIFI:T:WPA;S:${wifiEscape(ssid)};P:${wifiEscape(password)};;`
    : `WIFI:T:nopass;S:${wifiEscape(ssid)};;`;
}
