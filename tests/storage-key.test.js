import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listAssetRefs, storageKeyFromReference } from '../src/services/storage/storageKey.js';

const BUCKET = 'kapadkart-images';
const KEY = 'branding/tnt_203cd4c145eb4356917fe993a39b2a6b/6f6f713a-802c-47b9-86e3-5a3fce1f4a3b.webp';

describe('storage key extraction', () => {
  it('strips the bucket from a path-style R2 API URL', () => {
    const url = `https://1db5eecc7d6f2dd49c95ab36d701fe0f.r2.cloudflarestorage.com/${BUCKET}/${KEY}`;
    assert.equal(storageKeyFromReference(url, { bucket: BUCKET }), KEY);
  });

  it('keeps the key for the public r2.dev URL', () => {
    const url = `https://pub-b8599c847fde41329dae787c22486b1c.r2.dev/${KEY}`;
    assert.equal(storageKeyFromReference(url, { bucket: BUCKET }), KEY);
  });

  it('keeps the key for a virtual-hosted R2 URL', () => {
    const url = `https://${BUCKET}.1db5eecc7d6f2dd49c95ab36d701fe0f.r2.cloudflarestorage.com/${KEY}`;
    assert.equal(storageKeyFromReference(url, { bucket: BUCKET }), KEY);
  });

  it('keeps a local uploads path', () => {
    assert.equal(
      storageKeyFromReference('http://localhost:4000/uploads/products/shop/file.webp', { bucket: BUCKET }),
      'products/shop/file.webp'
    );
  });

  it('ignores inline images and built-in assets', () => {
    assert.equal(storageKeyFromReference('data:image/png;base64,abc'), null);
    assert.equal(storageKeyFromReference('blob:http://localhost/123'), null);
    assert.equal(storageKeyFromReference('/kk-favicon.svg'), null);
  });

  it('lists each URL inside a product image JSON array', () => {
    const kept = `https://pub-example.r2.dev/products/shop/keep.webp`;
    const removed = `https://pub-example.r2.dev/products/shop/gone.webp`;
    const refs = listAssetRefs(JSON.stringify([kept, removed]));
    assert.deepEqual(refs, [kept, removed]);
    assert.equal(storageKeyFromReference(removed, { bucket: BUCKET }), 'products/shop/gone.webp');
  });
});
