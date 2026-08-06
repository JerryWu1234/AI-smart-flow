import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SignatureEnvelope {
  algorithm: "Ed25519";
  keyId: string;
  signer: "smartflow-local-daemon";
  protocolVersion: "smartflow.v5";
  canonicalManifestHash: string;
  signature: string;
  signedAt: string;
}

export interface InstallationSigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

function publicKeyBytes(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("SIGNING_PUBLIC_KEY_NOT_ED25519");
  }
  const bytes = Buffer.from(jwk.x, "base64url");
  if (bytes.byteLength !== 32) throw new Error("SIGNING_PUBLIC_KEY_RAW_LENGTH_INVALID");
  return bytes;
}

export function exportSigningPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" });
}

export function signingKeyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKeyBytes(publicKey)).digest("hex");
}

export async function loadOrCreateInstallationSigningKey(path: string): Promise<InstallationSigningKey> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const generated = generateKeyPairSync("ed25519");
    const pem = generated.privateKey.export({ format: "pem", type: "pkcs8" });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, pem, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    privateKey = generated.privateKey;
  }
  const publicKey = createPublicKey(
    privateKey.export({ format: "pem", type: "pkcs8" })
  );
  return { privateKey, publicKey, keyId: signingKeyId(publicKey) };
}

export function signDeliveryManifest(
  canonicalManifestHash: string,
  key: InstallationSigningKey,
  signedAt = new Date().toISOString()
): SignatureEnvelope {
  if (!/^[a-f0-9]{64}$/u.test(canonicalManifestHash)) throw new Error("BUNDLE_MANIFEST_HASH_INVALID");
  return {
    algorithm: "Ed25519",
    keyId: key.keyId,
    signer: "smartflow-local-daemon",
    protocolVersion: "smartflow.v5",
    canonicalManifestHash,
    signature: sign(null, Buffer.from(canonicalManifestHash, "utf8"), key.privateKey).toString("base64"),
    signedAt
  };
}

export function verifyDeliverySignature(
  envelope: SignatureEnvelope,
  trustedPublicKeys: ReadonlyMap<string, KeyObject>
): boolean {
  const trustedKey = trustedPublicKeys.get(envelope.keyId);
  if (
    trustedKey === undefined ||
    !new Set<string>(["Ed25519"]).has(envelope.algorithm) ||
    !new Set<string>(["smartflow-local-daemon"]).has(envelope.signer) ||
    !new Set<string>(["smartflow.v5"]).has(envelope.protocolVersion) ||
    signingKeyId(trustedKey) !== envelope.keyId
  ) {
    return false;
  }
  return verify(
    null,
    Buffer.from(envelope.canonicalManifestHash, "utf8"),
    trustedKey,
    Buffer.from(envelope.signature, "base64")
  );
}

export function requireExternalBundleSignature(
  canonicalManifestHash: string,
  key: InstallationSigningKey | undefined
): SignatureEnvelope {
  if (key === undefined) throw new Error("SIGNING_KEY_UNAVAILABLE");
  return signDeliveryManifest(canonicalManifestHash, key);
}
