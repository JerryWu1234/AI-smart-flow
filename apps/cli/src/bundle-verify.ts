import { createPublicKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  readDeliveryBundleDirectory,
  signingKeyId,
  verifyDeliverySignature,
  verifyLocalDeliveryBundle,
  type DeliveryBundle,
  type SignatureEnvelope
} from "@smartflow/publish";

export interface BundleVerificationResult {
  localIntegrity: boolean;
  trustedSignature: boolean;
  valid: boolean;
}

export async function verifyBundleDirectoryForCli(
  directory: string,
  options: { trustedKeyPath?: string; trustedFingerprint?: string }
): Promise<BundleVerificationResult> {
  const loaded = await readDeliveryBundleDirectory(directory);
  const fingerprint = options.trustedFingerprint?.replace(/^sha256:/u, "");
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("TRUSTED_FINGERPRINT_INVALID");
  }
  let trustedKey: KeyObject | undefined;
  if (options.trustedKeyPath !== undefined) {
    trustedKey = createPublicKey(await readFile(options.trustedKeyPath));
    if (fingerprint !== undefined && signingKeyId(trustedKey) !== fingerprint) {
      throw new Error("TRUSTED_KEY_FINGERPRINT_MISMATCH");
    }
  } else if (fingerprint !== undefined && signingKeyId(loaded.signerPublicKey) === fingerprint) {
    trustedKey = loaded.signerPublicKey;
  }
  if (trustedKey === undefined) throw new Error("BUNDLE_TRUST_ANCHOR_REQUIRED");
  return verifyBundleForCli(
    loaded.bundle,
    loaded.envelope,
    new Map([[signingKeyId(trustedKey), trustedKey]])
  );
}

export function verifyBundleForCli(
  bundle: DeliveryBundle,
  envelope: SignatureEnvelope | undefined,
  trustedKeys: ReadonlyMap<string, KeyObject>
): BundleVerificationResult {
  const localIntegrity = verifyLocalDeliveryBundle(bundle);
  const trustedSignature =
    envelope !== undefined &&
    envelope.canonicalManifestHash === bundle.canonicalManifestHash &&
    verifyDeliverySignature(envelope, trustedKeys);
  return { localIntegrity, trustedSignature, valid: localIntegrity && trustedSignature };
}
