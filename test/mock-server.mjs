// A tiny local stand-in for the API: scripted answers, every request recorded.
import { createServer } from 'node:http';

export const reply = (status = 200, body = null, headers = {}) => {
  if (body instanceof Uint8Array || typeof body === 'string') return { status, headers, body };
  if (body === null) return { status, headers, body: '' };
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
};

export const error = (status, code, message = '', headers = {}) => reply(status, { error: { code, message } }, headers);

/**
 * `api.routes.set('GET /v1/me', answer)`: an answer, a list of answers (served in turn, the
 * last repeating), or a function of the request.
 */
export async function startMock() {
  const routes = new Map();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    requests.push(record);
    let route = routes.get(`${req.method} ${url.pathname}`);
    let answer;
    if (route === undefined) answer = error(404, 'not_found', 'route not found');
    else if (Array.isArray(route)) answer = route.length > 1 ? route.shift() : route[0];
    else if (typeof route === 'function') answer = route(record);
    else answer = route;
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    routes,
    requests,
    last: () => requests[requests.length - 1],
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
