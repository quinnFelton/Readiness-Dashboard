// Must match TOKEN_DATA_KEY_CONTEXT in apps/api/src/crypto/token-cipher.ts. The IAM condition below
// and the `aws kms generate-data-key-without-plaintext --encryption-context` command in DEPLOY.md
// both use it, so a data key made for another purpose cannot be decrypted by these roles.
export const TOKEN_DATA_KEY_PURPOSE = 'rd-token-data-key';

/** Placeholder written into Secrets Manager entries a human must fill (apps/api treats it as unset). */
export const PLACEHOLDER = 'REPLACE_ME';
