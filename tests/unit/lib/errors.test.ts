import { describe, it, expect } from 'vitest';
import { UserError } from '../../../src/lib/errors.js';

describe('UserError', () => {
  it('sets message correctly', () => {
    const err = new UserError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('sets name to UserError', () => {
    const err = new UserError('x');
    expect(err.name).toBe('UserError');
  });

  it('is an instance of Error', () => {
    expect(new UserError('x')).toBeInstanceOf(Error);
  });

  it('is identifiable with instanceof', () => {
    const err: unknown = new UserError('x');
    expect(err instanceof UserError).toBe(true);
  });
});
