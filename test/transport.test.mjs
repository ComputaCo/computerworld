// cw-ssh.v1 (cw-ssh-transport.mjs) between two in-memory sockets: order, fragmentation, directional EOF, credit,
// a stalled reader and a lost link. The sockets are the one edge faked here: a WebSocket pair is all they model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE, CREDIT, DATA, EOF, MAX_FRAME, WINDOW, framedStream } from '../cw-ssh-transport.mjs';

/** Two connected sockets with the WebSocket EventTarget API; messages are delivered asynchronously, in order. */
function pair() {
  const make = () => {
    const t = new EventTarget();
    t.sent = [];
    t.readyState = 1;
    return t;
  };
  const a = make(), b = make();
  const wire = (from, to) => {
    from.send = (bytes) => {
      if (from.readyState !== 1) return;
      const copy = new Uint8Array(bytes).buffer;
      from.sent.push(new Uint8Array(copy));
      queueMicrotask(() => to.readyState === 1 && to.dispatchEvent(Object.assign(new Event('message'), { data: copy })));
    };
    from.close = (code = 1000) => {
      if (from.readyState !== 1) return;
      from.readyState = 3;
      setTimeout(() => {
        if (to.readyState === 1) {
          to.readyState = 3;
          to.dispatchEvent(Object.assign(new Event('close'), { code }));
        }
        from.dispatchEvent(Object.assign(new Event('close'), { code }));
      }, 1);
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}
const collect = (stream) => new Promise((resolve, reject) => {
  const parts = [];
  stream.on('data', (c) => parts.push(c));
  stream.on('end', () => resolve(Buffer.concat(parts)));
  stream.on('error', reject);
});

test('bytes arrive whole and in order across frames, and each direction ends on its own', async () => {
  const [sa, sb] = pair();
  const a = framedStream(sa), b = framedStream(sb);
  const big = Buffer.alloc(3 * WINDOW + 12345);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
  const atB = collect(b);
  a.end(big);
  assert.deepEqual(await atB, big);
  // A's direction is done; B's still flows, and is drained after A's EOF.
  const atA = collect(a);
  b.write('after ');
  b.end('eof');
  assert.equal((await atA).toString(), 'after eof');
  // Every DATA frame was within the limit, and the window was respected by credit.
  const frames = sa.sent.filter((f) => f[0] === DATA);
  assert.ok(frames.every((f) => f.length - 1 <= MAX_FRAME));
  assert.ok(sb.sent.some((f) => f[0] === CREDIT));
  assert.equal(sa.sent.filter((f) => f[0] === EOF).length, 1);
});

test('a reader that stops taking bytes holds the sender to one window', async () => {
  const [sa, sb] = pair();
  const a = framedStream(sa), b = framedStream(sb);
  b.pause();
  let accepted = 0;
  const chunk = Buffer.alloc(8192);
  for (let i = 0; i < 200; i++) a.write(chunk, () => (accepted += chunk.length));
  await new Promise((r) => setTimeout(r, 50));
  // While B read nothing, at most the window and B's own buffer crossed the wire, and nothing more was accepted.
  const bound = WINDOW + b.readableHighWaterMark;
  assert.ok(a.stats.sent <= bound, `sent ${a.stats.sent}`);
  assert.ok(accepted <= bound);
  assert.ok(b.readableLength <= bound);
  b.resume();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.stats.sent, 200 * 8192);
  a.destroy();
});

test('a peer that breaks the protocol is closed: DATA beyond credit, DATA after EOF, text, unknown type', async () => {
  for (const evil of [
    (s) => { for (let i = 0; i < WINDOW / MAX_FRAME + 1; i++) s.send(Uint8Array.of(DATA, ...new Uint8Array(MAX_FRAME))); },
    (s) => { s.send(Uint8Array.of(EOF)); s.send(Uint8Array.of(DATA, 1)); },
    (s) => s.send(Uint8Array.of(9)),
    (s) => s.send(Uint8Array.of(DATA)),
    // Nothing binary: the text message below is the violation.
    () => {},
  ]) {
    const [sa, sb] = pair();
    let closed = null;
    const b = framedStream(sb, { onClose: (c) => (closed = c) });
    b.on('error', () => {});
    // B reads nothing, so it gives no credit back.
    evil(sa);
    await new Promise((r) => setTimeout(r, 20));
    if (!closed) sb.dispatchEvent(Object.assign(new Event('message'), { data: 'a text message' }));
    assert.equal(closed?.code, 1002, JSON.stringify(closed));
    assert.ok(sb.sent.some((f) => f[0] === CLOSE));
  }
});

test('a link lost mid-stream is an error, not an end; nothing is resent', async () => {
  const [sa, sb] = pair();
  const a = framedStream(sa);
  a.on('error', () => {});
  const b = framedStream(sb);
  const got = [];
  b.on('data', (c) => got.push(c));
  const outcome = new Promise((resolve) => {
    b.on('end', () => resolve('end'));
    b.on('error', (e) => resolve(e.message));
  });
  a.write('half a comm');
  await new Promise((r) => setTimeout(r, 5));
  sa.close(1006);
  assert.match(await outcome, /1006/);
  assert.equal(Buffer.concat(got).toString(), 'half a comm');
  assert.equal(sa.sent.filter((f) => f[0] === DATA).length, 1);
});

test('a byte ceiling closes the connection', async () => {
  const [sa, sb] = pair();
  let closed = null;
  const a = framedStream(sa, { maxBytes: 1000, onClose: (c) => (closed = c) });
  a.on('error', () => {});
  framedStream(sb).on('error', () => {}).resume();
  a.write(Buffer.alloc(2000));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed?.code, 1009);
});
