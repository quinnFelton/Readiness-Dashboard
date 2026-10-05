import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// PLAN §12 / CLAUDE.md rule 6: OAuth tokens are encrypted at rest. Prod uses KMS, dev uses a
// local AES key from .env; both sit behind this one interface. Methods are async because KMS is remote.

export interface TokenCipher {
  /**
   * `context` is bound as authenticated data (e.g. `${userId}:${provider}`) so a ciphertext copied
   * to another row fails to decrypt. Pass the same value to decrypt.
   */
  encrypt(plaintext: string, context?: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer, context?: string): Promise<string>;
}

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Layout: version(1) | iv(12) | authTag(16) | ciphertext. */
export class LocalAesGcmCipher implements TokenCipher {
  private readonly key: Buffer;

  constructor(base64Key: string | undefined) {
    const key = base64Key ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      // Deliberately does not echo the key material.
      throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    this.key = key;
  }

  async encrypt(plaintext: string, context = ''): Promise<Buffer> {
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]);
  }

  async decrypt(ciphertext: Buffer, context = ''): Promise<string> {
    if (ciphertext.length < 1 + IV_LEN + TAG_LEN || ciphertext[0] !== VERSION) {
      throw new Error('invalid ciphertext');
    }
    const iv = ciphertext.subarray(1, 1 + IV_LEN);
    const tag = ciphertext.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const ct = ciphertext.subarray(1 + IV_LEN + TAG_LEN);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from(context, 'utf8'));
    d.setAuthTag(tag);
    try {
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new Error('token decryption failed');
    }
  }
}

/**
 * KMS encryption context bound to the data key. The IAM policies in infra/cdk pin
 * `kms:EncryptionContext:purpose` to this value (infra/cdk/lib/constants.ts must stay in sync).
 */
export const TOKEN_DATA_KEY_CONTEXT = { purpose: 'rd-token-data-key' } as const;

/** The only KMS surface this class needs; lets tests inject a fake instead of hitting AWS. */
export interface KmsDecryptClient {
  send(command: unknown): Promise<{ Plaintext?: Uint8Array }>;
}

export interface KmsTokenCipherOptions {
  /** Base64 of the KMS-encrypted 32-byte data key (`CiphertextBlob`). Safe to keep in env/config. */
  encryptedDataKey?: string;
  client?: KmsDecryptClient;
}

/**
 * Prod implementation (PLAN §11/§12): envelope encryption. One AES-256 data key is stored
 * KMS-encrypted; it is decrypted ONCE per process (cold start) and then LocalAesGcmCipher does the
 * per-token work with the same `context` AAD and ciphertext layout as dev. No KMS call per token.
 * Lambdas therefore need only `kms:Decrypt` (on the data key, with the encryption context above).
 */
export class KmsTokenCipher implements TokenCipher {
  private inner?: Promise<LocalAesGcmCipher>;

  constructor(
    readonly keyId: string,
    private readonly opts: KmsTokenCipherOptions = {},
  ) {}

  private load(): Promise<LocalAesGcmCipher> {
    this.inner ??= this.fetchDataKey().catch((err: unknown) => {
      this.inner = undefined; // let the next call retry (e.g. transient KMS throttling)
      throw err;
    });
    return this.inner;
  }

  private async fetchDataKey(): Promise<LocalAesGcmCipher> {
    if (!this.opts.encryptedDataKey) {
      throw new Error('KMS_ENCRYPTED_DATA_KEY is required when using KmsTokenCipher');
    }
    // Imported lazily so local dev/tests that never use KMS don't load the AWS SDK.
    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
    const client: KmsDecryptClient = this.opts.client ?? new KMSClient({});
    const out = await client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(this.opts.encryptedDataKey, 'base64'),
        KeyId: this.keyId,
        EncryptionContext: { ...TOKEN_DATA_KEY_CONTEXT },
      }),
    );
    if (!out.Plaintext) throw new Error('KMS returned no plaintext for the data key');
    const key = Buffer.from(out.Plaintext);
    try {
      return new LocalAesGcmCipher(key.toString('base64'));
    } finally {
      key.fill(0);
    }
  }

  async encrypt(plaintext: string, context?: string): Promise<Buffer> {
    return (await this.load()).encrypt(plaintext, context);
  }

  async decrypt(ciphertext: Buffer, context?: string): Promise<string> {
    return (await this.load()).decrypt(ciphertext, context);
  }
}

/** KMS when running in production with KMS_KEY_ID; otherwise the local AES key. */
export function createTokenCipher(env: NodeJS.ProcessEnv = process.env): TokenCipher {
  if (env.NODE_ENV === 'production' && env.KMS_KEY_ID) {
    return new KmsTokenCipher(env.KMS_KEY_ID, { encryptedDataKey: env.KMS_ENCRYPTED_DATA_KEY });
  }
  return new LocalAesGcmCipher(env.TOKEN_ENCRYPTION_KEY);
}
