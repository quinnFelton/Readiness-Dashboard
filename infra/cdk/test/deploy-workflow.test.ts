import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wf = readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8');
const code = wf
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

describe('deploy.yml', () => {
  it('triggers only on manual dispatch', () => {
    const on = code.match(/^on:\n([\s\S]*?)^\S/m)?.[1] ?? '';
    expect(on).toContain('workflow_dispatch');
    expect(on).not.toMatch(/push:|pull_request|schedule:/);
  });
  it('uses an approval environment and OIDC, no long-lived keys', () => {
    expect(code).toMatch(/environment:/);
    expect(code).toMatch(/id-token:\s*write/);
    expect(code).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
    expect(code).toMatch(/role-to-assume/);
  });
  it('invokes migrate after the stack deploy step', () => {
    const deployAt = code.search(/cdk(\.js)?\s+deploy|cdk"?\s*,?\s*deploy/);
    expect(deployAt).toBeGreaterThan(-1);
    expect(code.indexOf('-migrate')).toBeGreaterThan(deployAt);
  });
});
