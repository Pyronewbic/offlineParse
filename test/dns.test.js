import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, describe, test } from 'node:test';
import { buildResponse, ipv4Bytes, startCatchAllDns } from '../src/dns.js';

const IP = ipv4Bytes('10.1.2.3');

function query(name, qtype = 1, { id = 0x1234, flags = 0x0100, qdcount = 1 } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(flags, 2);
  head.writeUInt16BE(qdcount, 4);
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, ...labels, Buffer.from([0]), tail]);
}

describe('buildResponse', () => {
  test('answers an A query with the laptop IP', () => {
    const q = query('captive.apple.com');
    const r = buildResponse(q, IP);
    assert.equal(r.readUInt16BE(0), 0x1234);
    assert.equal(r.readUInt16BE(2) & 0x8000, 0x8000);
    assert.equal(r.readUInt16BE(2) & 0x000f, 0);
    assert.equal(r.readUInt16BE(6), 1);
    assert.deepEqual([...r.subarray(r.length - 4)], [10, 1, 2, 3]);
  });

  test('AAAA and HTTPS queries get NODATA so phones fall back to IPv4', () => {
    for (const qtype of [28, 65]) {
      const r = buildResponse(query('connectivitycheck.gstatic.com', qtype), IP);
      assert.equal(r.readUInt16BE(2) & 0x000f, 0);
      assert.equal(r.readUInt16BE(6), 0);
    }
  });

  test('non-standard opcode gets NOTIMP, multi-question gets FORMERR', () => {
    assert.equal(buildResponse(query('a.b', 1, { flags: 0x2100 }), IP).readUInt16BE(2) & 0x000f, 4);
    assert.equal(buildResponse(query('a.b', 1, { qdcount: 2 }), IP).readUInt16BE(2) & 0x000f, 1);
  });

  test('drops malformed packets', () => {
    const good = query('example.com');
    const cases = {
      short: Buffer.alloc(5),
      'is a response': query('a.b', 1, { flags: 0x8100 }),
      truncated: good.subarray(0, good.length - 2),
      'unterminated name': good.subarray(0, 16),
      'compression pointer': Buffer.concat([good.subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]),
      'label over 63': Buffer.concat([good.subarray(0, 12), Buffer.from([64]), Buffer.alloc(64, 97), Buffer.from([0, 0, 1, 0, 1])]),
      'name over 255': query(Array(5).fill('a'.repeat(63)).join('.')),
    };
    for (const [label, packet] of Object.entries(cases)) assert.equal(buildResponse(packet, IP), null, label);
  });
});

describe('catch-all DNS server', () => {
  let server;
  let client;
  before(async () => {
    server = await startCatchAllDns({ answerIp: '10.1.2.3', host: '127.0.0.1', port: 0 });
    client = dgram.createSocket('udp4');
  });
  after(() => {
    server.close();
    client.close();
  });

  const ask = (packet) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), 2000);
    client.once('message', (msg) => {
      clearTimeout(timer);
      resolvePromise(msg);
    });
    client.send(packet, server.address().port, '127.0.0.1');
  });

  test('still answers after garbage packets', async () => {
    client.send(Buffer.from('garbage'), server.address().port, '127.0.0.1');
    client.send(Buffer.alloc(0), server.address().port, '127.0.0.1');
    const r = await ask(query('www.instagram.com'));
    assert.deepEqual([...r.subarray(r.length - 4)], [10, 1, 2, 3]);
  });
});
