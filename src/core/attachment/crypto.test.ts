import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK, RECORD_OVERHEAD, SyncCipher, cipheredSize, sha256HexBytes } from "./crypto.ts";

test("cipheredSize matches Android's chunk overhead", () => {
  assert.equal(cipheredSize(0), 0);
  assert.equal(cipheredSize(10), 10 + RECORD_OVERHEAD);
  assert.equal(cipheredSize(CHUNK), CHUNK + RECORD_OVERHEAD);
  assert.equal(cipheredSize(CHUNK + 1), CHUNK + 1 + 2 * RECORD_OVERHEAD);
});

test("seal/open round-trips empty, small and multi-chunk payloads", async () => {
  const cipher = await SyncCipher.create("dav-password");
  for (const size of [0, 10, CHUNK, CHUNK + 123]) {
    const plain = new Uint8Array(size);
    for (let i = 0; i < size; i++) plain[i] = i % 251;
    const sealed = await cipher.seal(plain);
    assert.equal(sealed.length, cipheredSize(size));
    const opened = await cipher.open(sealed);
    assert.deepEqual(opened, plain);
  }
});

test("the same password opens the payload; a wrong password fails", async () => {
  const plain = new TextEncoder().encode("hello attachment");
  const sealed = await (await SyncCipher.create("right")).seal(plain);
  const opened = await (await SyncCipher.create("right")).open(sealed);
  assert.deepEqual(opened, plain);
  const wrong = await SyncCipher.create("wrong");
  await assert.rejects(() => wrong.open(sealed));
});

test("sha256HexBytes matches the expected digest", async () => {
  assert.equal(
    await sha256HexBytes(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
