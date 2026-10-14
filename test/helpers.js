import { readFileSync } from 'node:fs';
import http from 'node:http';
import { configFromObject } from '../src/config.js';

export const BASE_CONFIG = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

export const rawConfig = (overrides = {}) => ({ ...structuredClone(BASE_CONFIG), ...overrides });
export const makeConfig = (overrides) => configFromObject(rawConfig(overrides));

/** Minimal HTTP client that never follows redirects and lets tests set any header. */
export function request({ host = '127.0.0.1', port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host, port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function postForm(port, path, fields, extra = {}) {
  const body = new URLSearchParams(fields).toString();
  return request({
    port,
    method: 'POST',
    path,
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    ...extra,
  });
}
