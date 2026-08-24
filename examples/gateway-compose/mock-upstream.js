// SPDX-License-Identifier: Apache-2.0
/**
 * The "existing API" the gateway fronts (#57, §11.3).
 *
 * Deliberately plain `node:http` with no dependencies, so `docker compose up`
 * does not need an install step for the one service whose only job is to answer.
 *
 * It stands in for an application the adopter cannot modify — which is the
 * entire premise of the standalone topology. Nothing here knows what MCP is.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const pets = [
  { id: 1, name: 'Rex', tag: 'dog' },
  { id: 2, name: 'Mia', tag: 'cat' },
];

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
};

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    console.log(`${req.method} ${path}`);

    if (req.method === 'GET' && path === '/pets') {
      const limit = Number(url.searchParams.get('limit') ?? pets.length);
      return json(res, 200, pets.slice(0, limit));
    }

    if (req.method === 'POST' && path === '/pets') {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      const created = { id: pets.length + 1, name: body.name ?? 'unnamed', tag: body.tag ?? null };
      pets.push(created);
      return json(res, 201, created);
    }

    const match = /^\/pets\/(\d+)$/.exec(path);
    if (req.method === 'GET' && match) {
      const pet = pets.find((p) => p.id === Number(match[1]));
      return pet ? json(res, 200, pet) : json(res, 404, { error: 'no such pet' });
    }

    json(res, 404, { error: 'no such route' });
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mock upstream listening on ${PORT}`);
});
