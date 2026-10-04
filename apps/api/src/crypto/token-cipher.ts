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
 * Prod implementation placeholder (phase 8 wires AWS). Same interface; KMS Encrypt/Decrypt with
 * EncryptionContext = { ctx: context } will replace the throws. No AWS SDK dependency yet.
 */
export class KmsTokenCipher implements TokenCipher {
  constructor(readonly keyId: string) {}

  async encrypt(_plaintext: string, _context?: string): Promise<Buffer> {
    throw new Error('KmsTokenCipher.encrypt is not implemented yet');
  }

  async decrypt(_ciphertext: Buffer, _context?: string): Promise<string> {
    throw new Error('KmsTokenCipher.decrypt is not implemented yet');
  }
}

/** KMS when running in production with KMS_KEY_ID; otherwise the local AES key. */
export function createTokenCipher(env: NodeJS.ProcessEnv = process.env): TokenCipher {
  if (env.NODE_ENV === 'production' && env.KMS_KEY_ID) return new KmsTokenCipher(env.KMS_KEY_ID);
  return new LocalAesGcmCipher(env.TOKEN_ENCRYPTION_KEY);
}
