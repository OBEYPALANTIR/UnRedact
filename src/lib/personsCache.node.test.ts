import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { crossReferencePersons } from './personsApi.ts';

test('cache separates sources and limits, owns cancellation, and retries failures over HTTP', async (t) => {
  const requests: string[] = [];
  let fail = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(req.url!);
    if (fail) { res.writeHead(500).end(); return; }
    const send = () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Array.from({ length: Number(url.searchParams.get('per_page')) }, (_, i) => ({
        id: i, name: url.pathname,
      }))));
    };
    if (url.pathname.includes('slow')) setTimeout(send, 50);
    else send();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}`;
  const query = (source: string, perPage: number, signal?: AbortSignal) =>
    crossReferencePersons('John Doe', { apiBaseUrl: root + source, perPage, signal });

  const first = await query('/a', 1);
  assert.equal(first.totalMatches, 1);
  first.crossReferences[0].matches[0].name = 'mutated';
  const cached = await query('/a', 1);
  assert.equal(cached.crossReferences[0].matches[0].name, '/a/v2/persons');
  assert.equal(requests.length, 1);
  assert.equal((await query('/a', 3)).totalMatches, 3);
  const other = await query('/b', 3);
  assert.equal(other.totalMatches, 3);
  assert.equal(other.crossReferences[0].matches[0].name, '/b/v2/persons');
  assert.equal(requests.length, 3);

  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await query('/a', 1, cancelled.signal)).totalMatches, 0);
  assert.equal(requests.length, 3);

  const controller = new AbortController();
  const cancelOne = query('/slow', 1, controller.signal);
  const keepOne = query('/slow', 1);
  setTimeout(() => controller.abort(), 10);
  assert.equal((await cancelOne).totalMatches, 0);
  assert.equal((await keepOne).totalMatches, 1);

  fail = true;
  assert.equal((await query('/retry', 1)).errors.length, 1);
  fail = false;
  assert.equal((await query('/retry', 1)).totalMatches, 1);
  assert.equal(requests.filter((url) => url.startsWith('/retry/')).length, 2);
});
