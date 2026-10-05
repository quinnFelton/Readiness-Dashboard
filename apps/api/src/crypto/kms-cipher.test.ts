import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  KmsTokenCipher,
  LocalAesGcmCipher,
  TOKEN_DATA_KEY_CONTEXT,
  createTokenCipher,
} from './token-cipher';

// KMS is mocked (CLAUDE.md rule 10): a fake client stands in for KMSClient.send(DecryptCommand).
const dataKey = randomBytes(32);
const blob = Buffer.from('kms-ciphertext-blob').toString('base64');

function fakeClient() {
  const send = vi.fn(async (_cmd: unknown) => ({ Plaintext: new Uint8Array(dataKey) }));
  return { send };
}

describe('KmsTokenCipher (envelope)', () => {
  it('decrypts the data key once, then does per-token work locally', async () => {
    const client = fakeClient();
    const cipher = new KmsTokenCipher('key-id', { encryptedDataKey: blob, client });

    const a = await cipher.encrypt('access-token', 'u1:oura');
    const b = await cipher.encrypt('refresh-token', 'u1:oura');
    expect(await cipher.decrypt(a, 'u1:oura')).toBe('access-token');
    expect(await cipher.decrypt(b, 'u1:oura')).toBe('refresh-token');
    expect(client.send).toHaveBeenCalledTimes(1); // no KMS round trip per token
  });

  it('sends the key id, ciphertext blob and encryption context to KMS', async () => {
    const client = fakeClient();
    await new KmsTokenCipher('key-id', { encryptedDataKey: blob, client }).encrypt('x');
    const cmd = client.send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input.KeyId).toBe('key-id');
    expect(cmd.input.EncryptionContext).toEqual(TOKEN_DATA_KEY_CONTEXT);
    expect(Buffer.from(cmd.input.CiphertextBlob as Uint8Array).toString('base64')).toBe(blob);
  });

  it('is wire-compatible with LocalAesGcmCipher and enforces the AAD context', async () => {
    const cipher = new KmsTokenCipher('k', { encryptedDataKey: blob, client: fakeClient() });
    const local = new LocalAesGcmCipher(dataKey.toString('base64'));
    const ct = await cipher.encrypt('secret', 'u1:strava');
    expect(await local.decrypt(ct, 'u1:strava')).toBe('secret');
    await expect(cipher.decrypt(ct, 'u2:strava')).rejects.toThrow(/decryption failed/);
  });

  it('retries after a failed data-key fetch instead of caching the failure', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ Plaintext: new Uint8Array(dataKey) });
    const cipher = new KmsTokenCipher('k', { encryptedDataKey: blob, client: { send } });
    await expect(cipher.encrypt('x')).rejects.toThrow(/Throttling/);
    await expect(cipher.encrypt('x')).resolves.toBeInstanceOf(Buffer);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('createTokenCipher passes KMS_ENCRYPTED_DATA_KEY through in production', () => {
    const c = createTokenCipher({
      NODE_ENV: 'production',
      KMS_KEY_ID: 'k',
      KMS_ENCRYPTED_DATA_KEY: blob,
    } as NodeJS.ProcessEnv);
    expect(c).toBeInstanceOf(KmsTokenCipher);
  });

  it('fails when KMS returns no plaintext', async () => {
    const cipher = new KmsTokenCipher('k', {
      encryptedDataKey: blob,
      client: { send: vi.fn(async () => ({})) },
    });
    await expect(cipher.encrypt('x')).rejects.toThrow(/no plaintext/);
  });
});
