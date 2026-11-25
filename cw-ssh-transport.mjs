// cw-ssh.v1: one ordered byte stream each way over a WebSocket, for SSH's bytes (docs/cloud-api.md § SSH transport).
//
// Every WebSocket message is binary: one type byte, then its payload. WebSocket message boundaries carry no meaning.
//   0x01 DATA    1..16384 bytes of the stream, in order
//   0x02 EOF     the sender will send no more DATA (its direction is done); the other direction goes on
//   0x03 CREDIT  u32 big-endian: the receiver has taken that many bytes; the sender may send that many more
//   0x04 CLOSE   u16 big-endian code, then UTF-8 reason: the whole connection ends, both directions, now
// Each direction starts with WINDOW bytes of credit. DATA beyond its credit, DATA after EOF, an empty or oversized
// DATA, a text message or an unknown type is a protocol error: the receiver sends CLOSE 1002 and closes.
// Nothing is resent: a connection that drops is over, and its SSH session with it.
//
// `framedStream(socket)` makes a Node Duplex of a WebSocket with the EventTarget API (Node's global WebSocket, or
// the ws package's). Its writable side ending sends EOF; the peer's EOF ends its readable side once drained.
import { Duplex } from 'node:stream';

export const SUBPROTOCOL = 'cw-ssh.v1';
export const DATA = 1, EOF = 2, CREDIT = 3, CLOSE = 4;
export const MAX_FRAME = 16384;
export const WINDOW = 256 * 1024;

const frame = (type, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
};
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
export const closeFrame = (code, reason = '') => {
  const text = new TextEncoder().encode(reason).subarray(0, 120);
  const b = new Uint8Array(2 + text.length);
  new DataView(b.buffer).setUint16(0, code);
  b.set(text, 2);
  return frame(CLOSE, b);
};

/**
 * A Duplex over `socket`. `limits.maxBytes` caps the bytes either way (CLOSE 1009 past it); `stats` counts what moved,
 * the most bytes held for the reader, and the most waiting for credit.
 */
export function framedStream(socket, { maxBytes = Infinity, onClose = () => {} } = {}) {
  socket.binaryType = 'arraybuffer';
  let sendCredit = WINDOW; // bytes we may still send
  let recvAllowed = WINDOW; // bytes the peer may still send us
  let owed = 0; // bytes taken from the peer and not yet credited
  let peerEof = false, ended = false, closed = false;
  const queue = []; // [Uint8Array, callback] waiting for credit
  const stats = { sent: 0, received: 0, queued_high: 0, held_high: 0, frames_in: 0, frames_out: 0 };
  let queued = 0;

  const send = (bytes) => {
    if (closed) return;
    stats.frames_out++;
    socket.send(bytes);
  };
  const fail = (code, reason) => {
    if (closed) return;
    send(closeFrame(code, reason));
    finish(code, reason, true);
  };
  const finish = (code, reason, local) => {
    if (closed) return;
    closed = true;
    try { socket.close(1000); } catch { /* already closed */ }
    for (const [, cb] of queue.splice(0)) cb(new Error(`connection closed: ${reason || code}`));
    onClose({ code, reason, local, stats });
    // A clean end keeps what the reader has not taken yet: it drains, then the readable side ends.
    if (code === 1000) {
      if (!peerEof) duplex.push(null);
    } else duplex.destroy(new Error(`cw-ssh.v1 closed (${code}${reason ? `: ${reason}` : ''})`));
  };
  /** Both directions done: the connection ends cleanly. */
  const maybeDone = () => {
    if (ended && peerEof && !closed) {
      send(closeFrame(1000));
      finish(1000, '', true);
    }
  };
  const pump = () => {
    while (queue.length && sendCredit > 0 && !closed) {
      const [chunk, cb] = queue[0];
      const n = Math.min(chunk.length, MAX_FRAME, sendCredit);
      send(frame(DATA, chunk.subarray(0, n)));
      sendCredit -= n;
      stats.sent += n;
      queued -= n;
      if (n === chunk.length) {
        queue.shift();
        cb();
      } else queue[0][0] = chunk.subarray(n);
    }
  };
  const credit = () => {
    if (owed > 0 && !closed) {
      send(frame(CREDIT, u32(owed)));
      recvAllowed += owed;
      owed = 0;
    }
  };

  const duplex = new Duplex({
    write(chunk, _enc, cb) {
      if (closed) return cb(new Error('connection closed'));
      if (stats.sent + queued + chunk.length > maxBytes) {
        fail(1009, 'byte limit');
        return cb(new Error('byte limit'));
      }
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      queue.push([bytes, cb]);
      queued += bytes.length;
      stats.queued_high = Math.max(stats.queued_high, queued);
      pump();
    },
    final(cb) {
      // Our direction is done once everything queued has gone.
      const done = () => {
        if (!closed && !ended) {
          ended = true;
          send(frame(EOF));
        }
        cb();
        maybeDone();
      };
      if (!queue.length) return done();
      queue.push([new Uint8Array(0), done]);
    },
    read() {
      credit();
    },
    destroy(err, cb) {
      if (!closed) fail(err ? 1011 : 1000, err ? 'aborted' : '');
      cb(err);
    },
  });
  duplex.stats = stats;

  socket.addEventListener('message', (ev) => {
    if (closed) return;
    if (typeof ev.data === 'string') return fail(1002, 'text message');
    const b = new Uint8Array(ev.data);
    stats.frames_in++;
    const type = b[0];
    if (type === DATA) {
      const n = b.length - 1;
      if (n < 1 || n > MAX_FRAME) return fail(1002, 'bad DATA size');
      if (peerEof) return fail(1002, 'DATA after EOF');
      if (n > recvAllowed) return fail(1002, 'DATA beyond credit');
      if (stats.received + n > maxBytes) return fail(1009, 'byte limit');
      recvAllowed -= n;
      stats.received += n;
      owed += n;
      // Credit is given back as the reader takes the bytes (read()), so at most WINDOW bytes wait here.
      if (duplex.push(Buffer.from(b.subarray(1)))) credit();
      stats.held_high = Math.max(stats.held_high, duplex.readableLength);
    } else if (type === EOF) {
      if (b.length !== 1 || peerEof) return fail(1002, 'bad EOF');
      peerEof = true;
      duplex.push(null);
      maybeDone();
    } else if (type === CREDIT) {
      if (b.length !== 5) return fail(1002, 'bad CREDIT');
      sendCredit += new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0);
      if (sendCredit > 64 * WINDOW) return fail(1002, 'credit overflow');
      pump();
    } else if (type === CLOSE) {
      const code = b.length >= 3 ? new DataView(b.buffer, b.byteOffset + 1, 2).getUint16(0) : 1000;
      finish(code, new TextDecoder().decode(b.subarray(3)), false);
    } else fail(1002, `unknown type ${type}`);
  });
  socket.addEventListener('close', (ev) => {
    // The socket ended without CLOSE: after both EOFs that is a clean end; otherwise the link was lost.
    if (!closed) finish(peerEof && ended ? 1000 : 1006, peerEof && ended ? '' : `link lost (${ev.code ?? '?'})`, false);
  });
  socket.addEventListener('error', () => {
    if (!closed) finish(1006, 'link error', false);
  });
  /** End the whole connection now (CLOSE), both directions. */
  duplex.closeAll = (code = 1000, reason = '') => fail(code, reason);
  return duplex;
}
