import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('packaged browser engine and simulation dependencies are available as JavaScript', async () => {
  const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const path of ['/engine.mjs', '/life.mjs', '/museum.mjs', '/repair.mjs']) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const text = await response.text();
    const expected = path === '/life.mjs' ? /export function unpackLifeFrame/
      : path === '/museum.mjs' ? /export function initializeMuseum/
      : path === '/repair.mjs' ? /export function evaluateRepairSource/ : /from '\.\/repair\.mjs'/;
    assert.match(text, expected);
    const head = await worker.fetch(new Request(`https://example.test${path}`, { method: 'HEAD' }), {});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});
