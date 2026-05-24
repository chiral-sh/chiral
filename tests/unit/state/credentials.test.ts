import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';
import { loadCredentials, writeCredentials, Credentials } from '../../../src/state/credentials.js';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:fs', async () => {
  const { fs } = await import('memfs');
  return { ...fs };
});

const EMPTY_CREDENTIALS: Credentials = {
  version: 1,
  credentials: {},
};

const FULL_CREDENTIALS: Credentials = {
  version: 1,
  credentials: {
    postgres: { dev: 'dev_postgres', staging: 'staging_postgres', prod: 'prod_postgres' },
    sendgrid: { dev: 'dev_sendgrid', prod: 'prod_sendgrid' },
  },
};

beforeEach(() => vol.reset());

describe('loadCredentials', () => {
  it('throws UserError when credentials.json does not exist', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    expect(() => loadCredentials('/project/.chiral')).toThrow(UserError);
    expect(() => loadCredentials('/project/.chiral')).toThrow('credentials.json');
  });

  it('throws UserError when credentials.json is invalid JSON', () => {
    vol.fromJSON({ '/project/.chiral/credentials.json': 'not json {{{' });
    expect(() => loadCredentials('/project/.chiral')).toThrow(UserError);
    expect(() => loadCredentials('/project/.chiral')).toThrow('valid JSON');
  });

  it('throws UserError when version field is wrong', () => {
    vol.fromJSON({
      '/project/.chiral/credentials.json': JSON.stringify({ version: 2, credentials: {} }),
    });
    expect(() => loadCredentials('/project/.chiral')).toThrow(UserError);
    expect(() => loadCredentials('/project/.chiral')).toThrow('Invalid credentials.json');
  });

  it('loads empty credentials file', () => {
    vol.fromJSON({
      '/project/.chiral/credentials.json': JSON.stringify(EMPTY_CREDENTIALS),
    });
    const result = loadCredentials('/project/.chiral');
    expect(result.version).toBe(1);
    expect(result.credentials).toEqual({});
  });

  it('loads credentials with multiple logical entries', () => {
    vol.fromJSON({
      '/project/.chiral/credentials.json': JSON.stringify(FULL_CREDENTIALS),
    });
    const result = loadCredentials('/project/.chiral');
    expect(result.credentials['postgres']).toEqual({
      dev: 'dev_postgres',
      staging: 'staging_postgres',
      prod: 'prod_postgres',
    });
    expect(result.credentials['sendgrid']['prod']).toBe('prod_sendgrid');
  });

  it('defaults credentials to empty object when field is omitted', () => {
    vol.fromJSON({
      '/project/.chiral/credentials.json': JSON.stringify({ version: 1 }),
    });
    const result = loadCredentials('/project/.chiral');
    expect(result.credentials).toEqual({});
  });
});

describe('writeCredentials', () => {
  it('writes credentials as formatted JSON', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeCredentials('/project/.chiral', EMPTY_CREDENTIALS);
    const raw = vol.readFileSync('/project/.chiral/credentials.json', 'utf-8') as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(EMPTY_CREDENTIALS);
  });

  it('can be read back by loadCredentials', () => {
    vol.fromJSON({ '/project/.chiral/': null });
    writeCredentials('/project/.chiral', FULL_CREDENTIALS);
    const result = loadCredentials('/project/.chiral');
    expect(result).toEqual(FULL_CREDENTIALS);
  });

  it('overwrites existing credentials.json on write', () => {
    vol.fromJSON({
      '/project/.chiral/credentials.json': JSON.stringify(FULL_CREDENTIALS),
    });
    writeCredentials('/project/.chiral', EMPTY_CREDENTIALS);
    const result = loadCredentials('/project/.chiral');
    expect(result.credentials).toEqual({});
  });

  it('throws UserError when directory does not exist', () => {
    vol.fromJSON({});
    expect(() => writeCredentials('/nonexistent/.chiral', EMPTY_CREDENTIALS)).toThrow(
      UserError,
    );
  });
});
