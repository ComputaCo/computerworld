#!/usr/bin/env node
// cw-ssh-proxy: OpenSSH's ProxyCommand for ComputerWorld's SSH (docs/cloud-api.md § SSH).
//
//   CW_SSH_GRANT=./grant.json ssh -o ProxyCommand=cw-ssh-proxy -o HostKeyAlias=<alias> … <login>@<alias>
//
// It opens the grant's wss:// URL (TLS verified), authenticated by the grant's credential in an Authorization header,
// and carries ssh's bytes over it (cw-ssh.v1): stdin to the server, the server to stdout, nothing else on either.
// Diagnostics go to stderr. It only moves bytes: the server authenticates your key and ssh checks the host key.
// The grant file is the JSON the API returned for the grant (websocket_url and credential at least), mode 0600;
// CW_SSH_GRANT names it, or the first argument does. It never reconnects: a dropped link ends the ssh session.
import { readFileSync, statSync } from 'node:fs';
import { SUBPROTOCOL, framedStream } from '../cw-ssh-transport.mjs';

const fail = (message, code = 255) => {
  process.stderr.write(`cw-ssh-proxy: ${message}\n`);
  process.exit(code);
};
const file = process.argv[2] || process.env.CW_SSH_GRANT;
if (!file) fail('name the grant file: CW_SSH_GRANT=<file> (the API\'s answer to POST /v1/simulations/{id}/ssh, mode 0600)');
let grant;
try {
  const mode = statSync(file).mode & 0o777;
  if (process.platform !== 'win32' && (mode & 0o077)) fail(`${file} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  grant = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(`cannot read the grant file ${file}: ${e.message}`);
}
if (typeof grant?.websocket_url !== 'string' || !/^wss?:\/\//.test(grant.websocket_url) || typeof grant.credential !== 'string') fail(`${file} has no websocket_url and credential`);
if (grant.websocket_url.startsWith('ws://') && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(grant.websocket_url)) fail('refusing an unencrypted ws:// URL that is not this machine');
if (typeof WebSocket !== 'function') fail('this Node has no WebSocket; use Node 22 or later');

// ssh ends its ProxyCommand with SIGHUP when it is done; handle it even where the parent left it ignored.
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));

const socket = new WebSocket(grant.websocket_url, { protocols: [SUBPROTOCOL], headers: { authorization: `Bearer ${grant.credential}` } });
socket.addEventListener('open', () => {
  if (socket.protocol !== SUBPROTOCOL) {
    socket.close(1002);
    fail(`the server did not speak ${SUBPROTOCOL}`);
  }
  const stream = framedStream(socket, {
    onClose: ({ code, reason }) => {
      if (code !== 1000) {
        process.stderr.write(`cw-ssh-proxy: connection closed (${code}${reason ? `: ${reason}` : ''})\n`);
        return process.exit(255);
      }
      // A clean end: everything received reaches stdout, then we leave (ssh reads our exit as its transport's end).
      const leave = () => process.stdout.write('', () => process.exit(0));
      if (stream.readableEnded) leave();
      else stream.once('end', () => setImmediate(leave));
    },
  });
  stream.on('error', () => {});
  process.stdin.pipe(stream);
  stream.pipe(process.stdout);
});
socket.addEventListener('error', (e) => {
  if (socket.readyState !== WebSocket.OPEN) fail(`cannot connect to ${new URL(grant.websocket_url).host}: ${e.message || 'refused (is the grant still valid?)'}`);
});
