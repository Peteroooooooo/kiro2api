import { describe, expect, it } from 'vitest';
import { parseImport } from '../../src/pool/import-credentials.js';

describe('parseImport', () => {
  it('reads a kiro.rs credentials.json array', () => {
    const text = JSON.stringify([
      {
        refreshToken: 'r1',
        clientId: 'c1',
        clientSecret: 's1',
        authMethod: 'idc',
        region: 'us-east-1',
      },
      { refreshToken: 'r2', clientId: 'c2', clientSecret: 's2', authMethod: 'idc' },
    ]);
    const { accounts, errors } = parseImport(text);
    expect(errors).toEqual([]);
    expect(accounts.map((a) => a.credentials.refreshToken)).toEqual(['r1', 'r2']);
    expect(accounts[0].credentials).toMatchObject({
      clientId: 'c1',
      clientSecret: 's1',
      region: 'us-east-1',
    });
  });

  it('merges a kiro-cli snake_case token row with its device registration pasted after it', () => {
    const text = [
      JSON.stringify({
        access_token: 'a',
        refresh_token: 'r',
        expires_at: '2026-10-29T10:00:00Z',
        region: 'us-east-1',
        start_url: 'https://view.awsapps.com/start',
      }),
      JSON.stringify({ client_id: 'cid', client_secret: 'csec', region: 'us-east-1' }),
    ].join('\n');
    const { accounts, errors } = parseImport(text, 'friend');
    expect(errors).toEqual([]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: 'friend',
      source: 'import',
      startUrl: undefined,
      credentials: { refreshToken: 'r', accessToken: 'a', clientId: 'cid', clientSecret: 'csec' },
    });
    expect(accounts[0].credentials.expiresAt).toBe('2026-10-29T10:00:00.000Z');
  });

  it('keeps an IAM Identity Center start URL', () => {
    const { accounts } = parseImport(
      JSON.stringify({
        credentials: { refreshToken: 'r', clientId: 'c', clientSecret: 's' },
        startUrl: 'https://d-123.awsapps.com/start',
      }),
    );
    expect(accounts[0].startUrl).toBe('https://d-123.awsapps.com/start');
  });

  it('rejects social logins and entries without a client registration', () => {
    const { accounts, errors } = parseImport(
      JSON.stringify([
        { refreshToken: 'r1', authMethod: 'social', provider: 'Github' },
        { refreshToken: 'r2', clientId: 'c2' },
      ]),
    );
    expect(accounts).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/social/);
    expect(errors[1]).toMatch(/clientSecret/);
  });

  it('reports invalid JSON and text without a refresh token', () => {
    expect(() => parseImport('not json')).toThrow(/not valid JSON/);
    expect(parseImport('{"clientId":"c"}').errors[0]).toMatch(/refreshToken/);
  });
});
