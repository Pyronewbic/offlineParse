import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { buildResponse, ipv4Bytes, queryName, startCatchAllDns } from '../src/dns.js';

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

  test('iCloud Private Relay names get NXDOMAIN for every type; other icloud.com names still point at the laptop', () => {
    for (const name of ['mask.icloud.com', 'mask-h2.icloud.com', 'MASK.iCloud.com']) {
      for (const qtype of [1, 28, 65]) {
        const r = buildResponse(query(name, qtype), IP);
        assert.equal(r.readUInt16BE(0), 0x1234, name);
        assert.equal(r.readUInt16BE(2) & 0x000f, 3, `${name} type ${qtype}`);
        assert.equal(r.readUInt16BE(6), 0);
      }
    }
    for (const name of ['www.icloud.com', 'x.mask.icloud.com', 'mask.icloud.com.evil']) {
      const r = buildResponse(query(name), IP);
      assert.equal(r.readUInt16BE(2) & 0x000f, 0, name);
      assert.deepEqual([...r.subarray(r.length - 4)], [10, 1, 2, 3], name);
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

test('a packet from source port 0 is dropped and the server keeps answering', async () => {
  const seen = [];
  const server = await startCatchAllDns({ answerIp: '10.1.2.3', host: '127.0.0.1', port: 0, onQuery: (name, _from, answered) => seen.push([name, answered]) });
  const client = dgram.createSocket('udp4');
  try {
    server.emit('message', query('captive.apple.com'), { address: '127.0.0.1', port: 0, family: 'IPv4', size: 0 });
    server.emit('message', Buffer.alloc(12), { address: '127.0.0.1', port: 0, family: 'IPv4', size: 12 });
    assert.deepEqual(seen, [['captive.apple.com', false], [null, false]], 'seen but not answered');
    const answer = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer after the port-0 packets')), 2000);
      client.once('message', (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      client.send(query('example.com'), server.address().port, '127.0.0.1');
    });
    assert.deepEqual([...answer.subarray(answer.length - 4)], [10, 1, 2, 3]);
  } finally {
    server.close();
    client.close();
  }
});

const lanAddress = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

test('bound to one address, replies come from that address', { skip: !lanAddress && 'no LAN address' }, async () => {
  const server = await startCatchAllDns({ answerIp: lanAddress, host: lanAddress, port: 0 });
  const client = dgram.createSocket('udp4');
  try {
    const rinfo = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 2000);
      client.once('message', (_msg, info) => {
        clearTimeout(timer);
        resolvePromise(info);
      });
      client.send(query('captive.apple.com'), server.address().port, lanAddress);
    });
    assert.equal(rinfo.address, lanAddress);
    assert.equal(server.address().address, lanAddress, 'not a wildcard socket');
  } finally {
    server.close();
    client.close();
  }
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

  test('setAnswerIp retargets live answers', async () => {
    try {
      server.setAnswerIp('10.4.5.6');
      const r = await ask(query('captive.apple.com'));
      assert.deepEqual([...r.subarray(r.length - 4)], [10, 4, 5, 6]);
    } finally {
      server.setAnswerIp('10.1.2.3');
    }
  });

  test('still answers after garbage packets', async () => {
    client.send(Buffer.from('garbage'), server.address().port, '127.0.0.1');
    client.send(Buffer.alloc(0), server.address().port, '127.0.0.1');
    const r = await ask(query('www.instagram.com'));
    assert.deepEqual([...r.subarray(r.length - 4)], [10, 1, 2, 3]);
  });
});

describe('queryName', () => {
  test('returns the dotted name, or null for malformed packets', () => {
    assert.equal(queryName(query('connectivitycheck.gstatic.com')), 'connectivitycheck.gstatic.com');
    assert.equal(queryName(Buffer.alloc(5)), null);
    const good = query('example.com');
    assert.equal(queryName(good.subarray(0, 16)), null, 'truncated label');
    assert.equal(queryName(Buffer.concat([good.subarray(0, 12), Buffer.from([0xc0, 0x0c])])), null, 'compression pointer');
  });

  test('onQuery reports each question and whether it was answered', async () => {
    const seen = [];
    const server = await startCatchAllDns({ answerIp: '10.1.2.3', host: '127.0.0.1', port: 0, onQuery: (...a) => seen.push(a) });
    const client = dgram.createSocket('udp4');
    try {
      await new Promise((resolvePromise) => {
        client.once('message', () => resolvePromise());
        client.send(query('captive.apple.com'), server.address().port, '127.0.0.1');
      });
      client.send(Buffer.from('junk'), server.address().port, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(seen, [['captive.apple.com', '127.0.0.1', true], [null, '127.0.0.1', false]]);
    } finally {
      server.close();
      client.close();
    }
  });
});
