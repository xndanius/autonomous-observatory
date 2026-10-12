import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('packaged Night Shift serves the gallery and retires old simulation assets and public world APIs', async () => {
  const source = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const path of ['/engine.mjs', '/life.mjs', '/museum.mjs', '/repair.mjs']) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), {});
    assert.equal(response.status, 404);
  }
  const page=await worker.fetch(new Request('https://example.test/'),{});
  assert.match(await page.text(),/<title>The Night Shift\b/);
  for(const path of ['/api/index','/api/state','/api/history?revision=128','/api/experiments/life-research-005/state'])assert.equal((await worker.fetch(new Request('https://example.test'+path),{})).status,410);
});
