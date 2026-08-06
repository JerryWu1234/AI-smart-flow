import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createDeliveryBundle,
  exportSigningPublicKey,
  serializeDeliveryBundle,
  signDeliveryManifest,
  signingKeyId,
  writeDeliveryBundleDirectory,
  type ApplyOperation
} from "@smartflow/publish";
import { describe, expect, it } from "vitest";

import { verifyBundleDirectoryForCli } from "./bundle-verify.js";

describe("smartflow bundle verify", () => {
  it("uses an explicit raw-key trust anchor and detects envelope tampering", async () => {
    const bytes = Buffer.from("content", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const operation: ApplyOperation = {
      path: "a.txt",
      type: "ADD",
      expectedOldKind: "ABSENT",
      expectedOldHash: null,
      expectedOldMode: null,
      newHash: sha256,
      newMode: 0o600,
      blobRef: { relativePath: "blob", sha256, size: bytes.byteLength }
    };
    const bundle = createDeliveryBundle({
      revision: 1,
      taskManifestHash: "a".repeat(64),
      baselineHash: "b".repeat(64),
      candidateHash: "c".repeat(64),
      reviewHash: "e".repeat(64),
      operations: [operation],
      patch: "+content",
      blobs: { "a.txt": bytes }
    });
    const pair = generateKeyPairSync("ed25519");
    const key = {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      keyId: signingKeyId(pair.publicKey)
    };
    const envelope = signDeliveryManifest(bundle.canonicalManifestHash, key);
    const serialized = serializeDeliveryBundle(
      bundle,
      envelope,
      exportSigningPublicKey(pair.publicKey)
    );
    const root = await mkdtemp(resolve(tmpdir(), "smartflow-cli-bundle-"));
    const directory = resolve(root, "bundle");
    await writeDeliveryBundleDirectory(directory, serialized);
    await expect(
      verifyBundleDirectoryForCli(directory, { trustedFingerprint: key.keyId })
    ).resolves.toEqual({ localIntegrity: true, trustedSignature: true, valid: true });
    await expect(
      verifyBundleDirectoryForCli(directory, { trustedFingerprint: "0".repeat(64) })
    ).rejects.toThrow(/BUNDLE_TRUST_ANCHOR_REQUIRED/u);

    const signaturePath = resolve(directory, "signature.json");
    const signature = JSON.parse(await readFile(signaturePath, "utf8")) as Record<string, unknown>;
    await writeFile(signaturePath, JSON.stringify({ ...signature, signature: "Zm9yZ2Vk" }), "utf8");
    await expect(
      verifyBundleDirectoryForCli(directory, { trustedFingerprint: key.keyId })
    ).resolves.toMatchObject({ valid: false, trustedSignature: false });
  });
});
