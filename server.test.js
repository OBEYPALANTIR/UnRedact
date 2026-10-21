import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { startServer } from './server.js';

const input = { base64: Buffer.from('%PDF-1.7\nfixture').toString('base64'), prompt: 'Read this fixture.' };

test('local server enforces its boundary and limits before calling the real SDK', async (t) => {
  let calls = 0;
  let heldResponse;
  let hold = false;
  let received;
  const upstream = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls++;
      received = JSON.parse(body);
      const finish = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ reconstructedText: 'fixture result', redactions: [] }) }] } }],
        }));
      };
      if (hold) heldResponse = finish;
      else finish();
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const server = await startServer({
    port: 0, production: true, apiKey: 'local-test-not-a-credential', model: 'fixture-model',
    apiBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
  });
  t.after(() => {
    server.closeAllConnections(); server.close();
    upstream.closeAllConnections(); upstream.close();
  });
  assert.equal(server.address().address, '127.0.0.1');
  const root = `http://127.0.0.1:${server.address().port}`;
  // Raw HTTP retains the deliberately invalid Host header that fetch normalizes.
  const post = (body = input, headers = {}) => new Promise((resolve, reject) => {
    const req = request(root + '/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  assert.equal((await post(input, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post(input, { Host: 'foreign.example' })).status, 403);
  assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ ...input, base64: 'not base64' })).status, 400);
  assert.equal((await post({ ...input, base64: Buffer.from('plain text').toString('base64') })).status, 400);
  assert.equal((await post({ ...input, prompt: 'a'.repeat(200_001) })).status, 400);
  assert.equal(calls, 0);

  const success = await post(input, { Origin: root });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { reconstructedText: 'fixture result', redactions: [] });
  assert.equal(received.contents[0].parts[0].inlineData.data, input.base64);
  assert.equal(received.generationConfig.maxOutputTokens, 8192);
  assert.equal(calls, 1);

  hold = true;
  const pending = post();
  for (let i = 0; !heldResponse && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(heldResponse, 'SDK request must reach the local HTTP fixture');
  assert.equal((await post()).status, 429);
  heldResponse();
  assert.equal((await pending).status, 200);
  hold = false;
  for (let i = 0; i < 8; i++) assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal(calls, 10);
});

test('server without an API key returns a clear local configuration error', async (t) => {
  const server = await startServer({ port: 0, production: true, apiKey: '' });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 503);
});
