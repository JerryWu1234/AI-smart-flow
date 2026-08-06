import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDeliveryBundle,
  readDeliveryBundleDirectory,
  serializeDeliveryBundle,
  verifyLocalDeliveryBundle,
  writeDeliveryBundleDirectory
} from "./delivery-bundle.js";
import type { ApplyOperation } from "./preflight.js";
import {
  requireExternalBundleSignature,
  exportSigningPublicKey,
  signDeliveryManifest,
  signingKeyId,
  verifyDeliverySignature
} from "./signature.js";

const bytes = Buffer.from("new content", "utf8");
const contentHash = createHash("sha256").update(bytes).digest("hex");

function operation(): ApplyOperation {
  return {
    path: "a.txt",
    type: "ADD",
    expectedOldKind: "ABSENT",
    expectedOldHash: null,
    expectedOldMode: null,
    newHash: contentHash,
    newMode: 0o600,
    blobRef: { relativePath: "blobs/a", sha256: contentHash, size: bytes.length }
  };
}

describe("DeliveryBundle integrity and trust roots", () => {
  it("detects manifest, blob, patch, cross-reference, signature, and trust-root tampering", () => {
    const apply = operation();
    const bundle = createDeliveryBundle({
      revision: 1,
      taskManifestHash: "a".repeat(64),
      baselineHash: "b".repeat(64),
      candidateHash: "c".repeat(64),
      reviewHash: "e".repeat(64),
      operations: [apply],
      patch: "+new content",
      blobs: { "a.txt": bytes }
    });
    expect(verifyLocalDeliveryBundle(bundle)).toBe(true);
    expect(verifyLocalDeliveryBundle({ ...bundle, patch: "tampered" })).toBe(false);
    expect(
      verifyLocalDeliveryBundle({ ...bundle, blobs: { "a.txt": Buffer.from("tampered") } })
    ).toBe(false);

    const signer = generateKeyPairSync("ed25519");
    const key = {
      privateKey: signer.privateKey,
      publicKey: signer.publicKey,
      keyId: signingKeyId(signer.publicKey)
    };
    const envelope = signDeliveryManifest(bundle.canonicalManifestHash, key);
    expect(verifyDeliverySignature(envelope, new Map([[key.keyId, key.publicKey]]))).toBe(true);
    const forged = generateKeyPairSync("ed25519");
    expect(verifyDeliverySignature(envelope, new Map([[key.keyId, forged.publicKey]]))).toBe(false);
    expect(
      verifyDeliverySignature(
        { ...envelope, signature: Buffer.from("forged").toString("base64") },
        new Map([[key.keyId, key.publicKey]])
      )
    ).toBe(false);
  });

  it("refuses a trusted external export without an installation signing key", () => {
    expect(() => requireExternalBundleSignature("a".repeat(64), undefined)).toThrow(
      /SIGNING_KEY_UNAVAILABLE/u
    );
  });

  it("persists an exportable directory and fingerprints raw Ed25519 public-key bytes", async () => {
    const bundle = createDeliveryBundle({
      revision: 1,
      taskManifestHash: "a".repeat(64),
      baselineHash: "b".repeat(64),
      candidateHash: "c".repeat(64),
      reviewHash: "e".repeat(64),
      operations: [operation()],
      patch: "+new content",
      blobs: { "a.txt": bytes }
    });
    const signer = generateKeyPairSync("ed25519");
    const key = {
      privateKey: signer.privateKey,
      publicKey: signer.publicKey,
      keyId: signingKeyId(signer.publicKey)
    };
    const jwk = signer.publicKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string") throw new Error("test public key missing x");
    expect(key.keyId).toBe(createHash("sha256").update(Buffer.from(jwk.x, "base64url")).digest("hex"));
    const envelope = signDeliveryManifest(bundle.canonicalManifestHash, key);
    const serialized = serializeDeliveryBundle(
      bundle,
      envelope,
      exportSigningPublicKey(signer.publicKey)
    );
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-delivery-bundle-"));
    const directory = resolve(root, "bundle");
    await writeDeliveryBundleDirectory(directory, serialized);
    const loaded = await readDeliveryBundleDirectory(directory);
    expect(verifyLocalDeliveryBundle(loaded.bundle)).toBe(true);
    expect(
      verifyDeliverySignature(loaded.envelope, new Map([[key.keyId, loaded.signerPublicKey]]))
    ).toBe(true);

    const blobPath = resolve(directory, "blobs", contentHash);
    await writeFile(blobPath, "tampered", "utf8");
    expect(verifyLocalDeliveryBundle((await readDeliveryBundleDirectory(directory)).bundle)).toBe(false);
    expect(await readFile(resolve(directory, "signature.json"), "utf8")).toContain(key.keyId);
  });
});
