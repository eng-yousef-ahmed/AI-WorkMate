import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  inspectManagedInstallTarget,
  installVerifiedFile,
  ManagedInstallError,
} from "../src/runtime/ManagedModelInstall";

test("inspectManagedInstallTarget distinguishes missing, verified, and corrupted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-inspect-model-"));
  try {
    const payload = Buffer.from("verified-model-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const path = join(root, "model.bin");
    assert.equal(await inspectManagedInstallTarget(path, sha256, payload.byteLength), "MISSING");
    await writeFile(path, payload);
    assert.equal(await inspectManagedInstallTarget(path, sha256, payload.byteLength), "VERIFIED");
    await writeFile(path, Buffer.from("tampered"));
    assert.equal(await inspectManagedInstallTarget(path, sha256, payload.byteLength), "CORRUPTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installVerifiedFile skips a SHA-verified file and never calls the transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-skip-model-"));
  try {
    const payload = Buffer.from("already-good");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(root, "tiny.bin"), payload);
    let downloads = 0;
    const result = await installVerifiedFile({
      directory: root,
      file: { filename: "tiny.bin", sha256, bytes: payload.byteLength, url: "https://example.invalid/tiny.bin" },
      transport: {
        async get() {
          downloads += 1;
          return { status: 200, body: bytesOf("should-not-run") };
        },
      },
    });
    assert.equal(result.alreadyVerified, true);
    assert.equal(downloads, 0);
    assert.equal(await readFile(join(root, "tiny.bin"), "utf8"), "already-good");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installVerifiedFile refuses to replace a corrupted file unless replaceCorrupted is set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-corrupt-model-"));
  try {
    const expected = Buffer.from("catalog-bytes");
    const sha256 = createHash("sha256").update(expected).digest("hex");
    await writeFile(join(root, "tiny.bin"), Buffer.from("bad"));
    let downloads = 0;
    await assert.rejects(
      installVerifiedFile({
        directory: root,
        file: { filename: "tiny.bin", sha256, bytes: expected.byteLength, url: "https://example.invalid/tiny.bin" },
        transport: {
          async get() {
            downloads += 1;
            return { status: 200, body: bytesOf(expected) };
          },
        },
      }),
      (error: unknown) => error instanceof ManagedInstallError && error.code === "CORRUPTED",
    );
    assert.equal(downloads, 0);
    const replaced = await installVerifiedFile({
      directory: root,
      file: { filename: "tiny.bin", sha256, bytes: expected.byteLength, url: "https://example.invalid/tiny.bin" },
      replaceCorrupted: true,
      transport: {
        async get() {
          downloads += 1;
          return { status: 200, body: bytesOf(expected) };
        },
      },
    });
    assert.equal(replaced.alreadyVerified, false);
    assert.equal(downloads, 1);
    assert.equal(await readFile(join(root, "tiny.bin"), "utf8"), "catalog-bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted download leaves no destination file and a missing shard can resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-workmate-resume-model-"));
  try {
    await mkdir(root, { recursive: true });
    const first = Buffer.from("shard-one");
    const second = Buffer.from("shard-two");
    const firstSha = createHash("sha256").update(first).digest("hex");
    const secondSha = createHash("sha256").update(second).digest("hex");
    await assert.rejects(
      installVerifiedFile({
        directory: root,
        file: { filename: "a.bin", sha256: firstSha, bytes: first.byteLength, url: "https://example.invalid/a.bin" },
        transport: {
          async get() {
            return {
              status: 200,
              body: (async function* () {
                yield first.subarray(0, 2);
                throw new Error("socket reset");
              })(),
            };
          },
        },
      }),
      (error: unknown) => error instanceof ManagedInstallError && error.code === "INTERRUPTED" && error.retryable,
    );
    assert.equal(await inspectManagedInstallTarget(join(root, "a.bin"), firstSha, first.byteLength), "MISSING");

    await writeFile(join(root, "a.bin"), first);
    const requested: string[] = [];
    const resumed = await installVerifiedFile({
      directory: root,
      file: { filename: "b.bin", sha256: secondSha, bytes: second.byteLength, url: "https://example.invalid/b.bin" },
      transport: {
        async get(url) {
          requested.push(url);
          return { status: 200, body: bytesOf(second) };
        },
      },
    });
    assert.deepEqual(requested, ["https://example.invalid/b.bin"]);
    assert.equal(resumed.alreadyVerified, false);
    assert.equal(await inspectManagedInstallTarget(join(root, "a.bin"), firstSha, first.byteLength), "VERIFIED");
    assert.equal(await inspectManagedInstallTarget(join(root, "b.bin"), secondSha, second.byteLength), "VERIFIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function* bytesOf(value: string | Buffer): AsyncIterable<Uint8Array> {
  yield Buffer.isBuffer(value) ? value : Buffer.from(value);
}
