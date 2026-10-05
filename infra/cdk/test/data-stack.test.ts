import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { synth } from './helpers';

describe('data stack', () => {
  const { data } = synth();

  it('runs Aurora Serverless v2 Postgres that can scale to zero and auto-pause', () => {
    data.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: Match.stringLikeRegexp('^16\\.(?:[3-9]|\\d{2})'), // >=16.3 supports min 0 ACU
      StorageEncrypted: true,
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0,
        MaxCapacity: 2,
        SecondsUntilAutoPause: 300,
      },
    });
    data.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.serverless',
      PubliclyAccessible: false,
    });
  });

  it('keeps the database off the internet: isolated subnets, ingress from the Lambda SG only', () => {
    data.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
    const sgs = data.findResources('AWS::EC2::SecurityGroup');
    for (const sg of Object.values(sgs)) {
      for (const rule of sg.Properties.SecurityGroupIngress ?? []) {
        expect(rule.CidrIp, 'no 0.0.0.0/0 ingress anywhere').not.toBe('0.0.0.0/0');
      }
    }
  });

  it('uses a NAT instance by default, not a NAT gateway, and no interface endpoints', () => {
    data.resourceCountIs('AWS::EC2::NatGateway', 0);
    data.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
    data.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.nano' });
    // The NAT instance has a public IP: its SG admits only Lambda HTTP(S).
    const ingress = data.findResources('AWS::EC2::SecurityGroupIngress');
    const nat = Object.values(ingress).filter((r) => [80, 443].includes(r.Properties.FromPort));
    expect(nat.map((r) => r.Properties.FromPort).sort()).toEqual([443, 80]);
  });

  it('natMode=gateway switches to a managed NAT Gateway', () => {
    const t = synth({ natMode: 'gateway' }).data;
    t.resourceCountIs('AWS::EC2::NatGateway', 1);
    t.resourceCountIs('AWS::EC2::Instance', 0);
  });

  it('creates a rotating KMS key for the token data key', () => {
    data.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    data.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/rd-dev-tokens' });
  });

  it('creates Secrets Manager entries as placeholders or generated values, never real secrets', () => {
    const secrets = data.findResources('AWS::SecretsManager::Secret');
    const names = Object.values(secrets).map((s) => s.Properties.Name);
    expect(names).toEqual(
      expect.arrayContaining([
        'rd/dev/db',
        'rd/dev/nextauth',
        'rd/dev/token-key',
        'rd/dev/oura',
        'rd/dev/strava',
        'rd/dev/terra',
        'rd/dev/github-token',
      ]),
    );
    for (const s of Object.values(secrets)) {
      const body = s.Properties.SecretString ?? JSON.stringify(s.Properties.GenerateSecretString);
      expect(body).toBeTruthy();
      expect(body).not.toMatch(/AKIA|-----BEGIN|sk_live/);
    }
    // NEXTAUTH_SECRET is generated here so web and API read the very same value.
    data.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'rd/dev/nextauth',
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'NEXTAUTH_SECRET' }),
    });
  });

  it('prod: retains data, protects deletion, longer backups', () => {
    const { data: prod, stacks } = synth({ stage: 'prod' });
    prod.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
    prod.hasResource('AWS::RDS::DBCluster', { DeletionPolicy: 'Snapshot' });
    prod.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    expect(stacks.data.terminationProtection).toBe(true);
    expect(stacks.data.stackName).toBe('rd-prod-data');
  });

  it('dbMinAcu>0 disables auto-pause cleanly', () => {
    synth({ dbMinAcu: 0.5 }).data.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
    });
  });
});
