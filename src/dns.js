// Answers every DNS A query with the laptop's IP so phones land on the sign-up portal.
import dgram from 'node:dgram';

const QR = 0x8000;
const AA = 0x0400;
const RD = 0x0100;
const RA = 0x0080;
const FORMERR = 1;
const NOTIMP = 4;
const TYPE_A = 1;
const CLASS_IN = 1;

function header(id, flags, qd, an) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(qd, 4);
  h.writeUInt16BE(an, 6);
  return h;
}

/** Response bytes for one query, or null to drop the packet. */
export function buildResponse(query, answerIp, ttl = 0) {
  if (query.length < 12) return null;
  const id = query.readUInt16BE(0);
  const flags = query.readUInt16BE(2);
  const qdcount = query.readUInt16BE(4);
  if (flags & QR) return null;
  const opcode = (flags >> 11) & 0xf;
  const base = QR | (opcode << 11) | AA | (flags & RD) | RA;

  if (qdcount !== 1) return header(id, base | FORMERR, 0, 0);

  let pos = 12;
  let total = 0;
  for (;;) {
    if (pos >= query.length) return null;
    const len = query[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if (len & 0xc0 || len > 63) return null;
    total += len + 1;
    if (total > 255) return null;
    pos += 1 + len;
  }
  if (pos + 4 > query.length) return null;
  const qtype = query.readUInt16BE(pos);
  const qclass = query.readUInt16BE(pos + 2);
  const question = query.subarray(12, pos + 4);

  if (opcode !== 0) return Buffer.concat([header(id, base | NOTIMP, 1, 0), question]);

  if (qtype === TYPE_A && qclass === CLASS_IN) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(TYPE_A, 2);
    rr.writeUInt16BE(CLASS_IN, 4);
    rr.writeUInt32BE(ttl, 6);
    rr.writeUInt16BE(4, 10);
    answerIp.copy(rr, 12);
    return Buffer.concat([header(id, base, 1, 1), question, rr]);
  }
  return Buffer.concat([header(id, base, 1, 0), question]);
}

export function ipv4Bytes(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

/** Resolves once bound to a socket that answers until closed; `sock.setAnswerIp` retargets it. */
export function startCatchAllDns({ answerIp, host = '0.0.0.0', port = 53, ttl = 0 }) {
  let ipBytes = ipv4Bytes(answerIp);
  const sock = dgram.createSocket('udp4');
  sock.setAnswerIp = (ip) => {
    ipBytes = ipv4Bytes(ip);
  };
  sock.on('message', (msg, rinfo) => {
    const response = buildResponse(msg, ipBytes, ttl);
    if (response) sock.send(response, rinfo.port, rinfo.address, () => {});
  });
  return new Promise((resolvePromise, reject) => {
    sock.once('error', reject);
    sock.bind(port, host, () => {
      sock.off('error', reject);
      sock.on('error', (e) => console.error(`dns: ${e.message}`));
      resolvePromise(sock);
    });
  });
}
