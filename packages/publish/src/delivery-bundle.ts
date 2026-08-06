import { createHash } from "node:crypto";
import { createPublicKey, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalOperations, type ApplyOperation } from "./preflight.js";
import {
  signingKeyId,
  type SignatureEnvelope
} from "./signature.js";

export interface DeliveryBlob {
  path: string;
  sha256: string;
  size: number;
}

export interface DeliveryBundleInput {
  revision: number;
  taskManifestHash: string;
  baselineHash: string;
  candidateHash: string;
  reviewHash: string;
  operations: ApplyOperation[];
  patch: string;
  blobs: Record<string, Uint8Array>;
}

export interface DeliveryBundleManifest {
  schemaVersion: 1;
  protocolVersion: "smartflow.v5";
  revision: number;
  taskManifestHash: string;
  baselineHash: string;
  candidateHash: string;
  reviewHash: string;
  operations: ApplyOperation[];
  patchHash: string;
  blobs: DeliveryBlob[];
}

export interface DeliveryBundle {
  manifest: DeliveryBundleManifest;
  canonicalManifestHash: string;
  blobs: Record<string, Uint8Array>;
  patch: string;
}

export interface SerializedDeliveryBundle {
  schemaVersion: 1;
  bundle: {
    manifest: DeliveryBundleManifest;
    canonicalManifestHash: string;
    blobs: Record<string, string>;
    patch: string;
  };
  envelope: SignatureEnvelope;
  signerPublicKeyPem: string;
}

export interface DeliveryBundleDirectory {
  bundle: DeliveryBundle;
  envelope: SignatureEnvelope;
  signerPublicKey: KeyObject;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createDeliveryBundle(input: DeliveryBundleInput): DeliveryBundle {
  const operations = canonicalOperations(input.operations);
  const blobs = Object.entries(input.blobs)
    .map(([path, bytes]) => ({ path, sha256: hash(bytes), size: bytes.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const operationBlobPaths = operations
    .filter((operation) => operation.blobRef !== null)
    .map((operation) => operation.path)
    .sort();
  if (JSON.stringify(operationBlobPaths) !== JSON.stringify(blobs.map((blob) => blob.path))) {
    throw new Error("DELIVERY_BUNDLE_BLOB_CROSS_REFERENCE_INVALID");
  }
  for (const operation of operations) {
    const blob = input.blobs[operation.path];
    if (
      blob !== undefined &&
      (hash(blob) !== operation.newHash ||
        operation.blobRef?.sha256 !== operation.newHash ||
        operation.blobRef.size !== blob.byteLength)
    ) {
      throw new Error(`DELIVERY_BUNDLE_OPERATION_HASH_MISMATCH: ${operation.path}`);
    }
  }
  const manifest: DeliveryBundleManifest = {
    schemaVersion: 1,
    protocolVersion: "smartflow.v5",
    revision: input.revision,
    taskManifestHash: input.taskManifestHash,
    baselineHash: input.baselineHash,
    candidateHash: input.candidateHash,
    reviewHash: input.reviewHash,
    operations,
    patchHash: hash(input.patch),
    blobs
  };
  return {
    manifest,
    canonicalManifestHash: hash(canonical(manifest)),
    blobs: { ...input.blobs },
    patch: input.patch
  };
}

export function verifyLocalDeliveryBundle(bundle: DeliveryBundle): boolean {
  let operations: ApplyOperation[];
  try {
    operations = canonicalOperations(bundle.manifest.operations);
  } catch {
    return false;
  }
  if (
    canonical(operations) !== canonical(bundle.manifest.operations) ||
    hash(canonical(bundle.manifest)) !== bundle.canonicalManifestHash ||
    hash(bundle.patch) !== bundle.manifest.patchHash
  ) {
    return false;
  }
  if (Object.keys(bundle.blobs).sort().join("\0") !== bundle.manifest.blobs.map((blob) => blob.path).join("\0")) {
    return false;
  }
  for (const blob of bundle.manifest.blobs) {
    const bytes = bundle.blobs[blob.path];
    if (bytes === undefined || bytes.byteLength !== blob.size || hash(bytes) !== blob.sha256) return false;
  }
  for (const operation of operations) {
    const bytes = bundle.blobs[operation.path];
    if (
      operation.blobRef !== null &&
      (bytes === undefined ||
        hash(bytes) !== operation.newHash ||
        operation.blobRef.sha256 !== operation.newHash ||
        operation.blobRef.size !== bytes.byteLength)
    ) {
      return false;
    }
  }
  return true;
}

export function serializeDeliveryBundle(
  bundle: DeliveryBundle,
  envelope: SignatureEnvelope,
  signerPublicKeyPem: string
): Uint8Array {
  if (
    !verifyLocalDeliveryBundle(bundle) ||
    envelope.canonicalManifestHash !== bundle.canonicalManifestHash
  ) {
    throw new Error("DELIVERY_BUNDLE_SERIALIZATION_INVALID");
  }
  const publicKey = createPublicKey(signerPublicKeyPem);
  if (signingKeyId(publicKey) !== envelope.keyId) {
    throw new Error("DELIVERY_BUNDLE_SIGNER_KEY_MISMATCH");
  }
  const serialized: SerializedDeliveryBundle = {
    schemaVersion: 1,
    bundle: {
      manifest: bundle.manifest,
      canonicalManifestHash: bundle.canonicalManifestHash,
      blobs: Object.fromEntries(
        Object.entries(bundle.blobs).map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")])
      ),
      patch: bundle.patch
    },
    envelope,
    signerPublicKeyPem
  };
  return Buffer.from(canonical(serialized), "utf8");
}

export function parseSerializedDeliveryBundle(bytes: Uint8Array): DeliveryBundleDirectory {
  const value = JSON.parse(
    new TextDecoder().decode(bytes)
  ) as Partial<SerializedDeliveryBundle>;
  if (
    value.schemaVersion !== 1 ||
    value.bundle === undefined ||
    value.envelope === undefined ||
    typeof value.signerPublicKeyPem !== "string"
  ) {
    throw new Error("DELIVERY_BUNDLE_SERIALIZED_FORMAT_INVALID");
  }
  const bundle: DeliveryBundle = {
    manifest: value.bundle.manifest,
    canonicalManifestHash: value.bundle.canonicalManifestHash,
    blobs: Object.fromEntries(
      Object.entries(value.bundle.blobs).map(([path, encoded]) => [path, Buffer.from(encoded, "base64")])
    ),
    patch: value.bundle.patch
  };
  const signerPublicKey = createPublicKey(value.signerPublicKeyPem);
  if (
    !verifyLocalDeliveryBundle(bundle) ||
    value.envelope.canonicalManifestHash !== bundle.canonicalManifestHash ||
    signingKeyId(signerPublicKey) !== value.envelope.keyId
  ) {
    throw new Error("DELIVERY_BUNDLE_SERIALIZED_INTEGRITY_INVALID");
  }
  return { bundle, envelope: value.envelope, signerPublicKey };
}

export async function writeDeliveryBundleDirectory(
  directory: string,
  serializedBytes: Uint8Array
): Promise<void> {
  const parsed = parseSerializedDeliveryBundle(serializedBytes);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(resolve(directory, "blobs"), { mode: 0o700 });
  await Promise.all([
    writeFile(resolve(directory, "manifest.json"), canonical(parsed.bundle.manifest), { mode: 0o600, flag: "wx" }),
    writeFile(resolve(directory, "manifest.sha256"), `${parsed.bundle.canonicalManifestHash}\n`, { mode: 0o600, flag: "wx" }),
    writeFile(resolve(directory, "patch.diff"), parsed.bundle.patch, { mode: 0o600, flag: "wx" }),
    writeFile(resolve(directory, "signature.json"), canonical(parsed.envelope), { mode: 0o600, flag: "wx" }),
    writeFile(
      resolve(directory, "public-key.pem"),
      parsed.signerPublicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o600, flag: "wx" }
    ),
    ...[...new Map(parsed.bundle.manifest.blobs.map((blob) => [blob.sha256, blob])).values()].map((blob) => {
      const content = parsed.bundle.blobs[blob.path];
      if (content === undefined) throw new Error(`DELIVERY_BUNDLE_BLOB_MISSING: ${blob.path}`);
      return writeFile(resolve(directory, "blobs", blob.sha256), content, { mode: 0o600, flag: "wx" });
    })
  ]);
}

export async function readDeliveryBundleDirectory(directory: string): Promise<DeliveryBundleDirectory> {
  const [manifestBytes, manifestHashBytes, patchBytes, envelopeBytes, publicKeyBytes] = await Promise.all([
    readFile(resolve(directory, "manifest.json")),
    readFile(resolve(directory, "manifest.sha256")),
    readFile(resolve(directory, "patch.diff")),
    readFile(resolve(directory, "signature.json")),
    readFile(resolve(directory, "public-key.pem"))
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DeliveryBundleManifest;
  const blobs: Record<string, Uint8Array> = {};
  for (const blob of manifest.blobs) {
    blobs[blob.path] = await readFile(resolve(directory, "blobs", blob.sha256));
  }
  const bundle: DeliveryBundle = {
    manifest,
    canonicalManifestHash: new TextDecoder().decode(manifestHashBytes).trim(),
    blobs,
    patch: new TextDecoder().decode(patchBytes)
  };
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as SignatureEnvelope;
  const signerPublicKey = createPublicKey(publicKeyBytes);
  return { bundle, envelope, signerPublicKey };
}
