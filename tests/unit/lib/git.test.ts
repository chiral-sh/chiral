import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserError } from '../../../src/lib/errors.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { getGitActor } from '../../../src/lib/git.js';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getGitActor', () => {
  it('returns the trimmed git user email', () => {
    mockExecSync.mockReturnValue('alice@example.com\n' as never);
    expect(getGitActor()).toBe('alice@example.com');
  });

  it('throws UserError when git config user.email is not set', () => {
    mockExecSync.mockImplementation(() => { throw new Error('exit 1'); });
    expect(() => getGitActor()).toThrow(UserError);
    expect(() => getGitActor()).toThrow('git config user.email');
  });
});
