import { describe, expect, it } from 'vitest';
import { KkError, EXIT_CODES, normalizeError } from '../../src/domain/contracts/kk-error.js';

describe('KkError', () => {
  it('preserves a closed machine code and exit meaning', () => {
    const error = new KkError('No session', {
      code: 'auth_required',
      exitCode: EXIT_CODES.dependency,
    });
    expect(error.code).toBe('auth_required');
    expect(error.exitCode).toBe(4);
  });

  it('normalizes unknown failures without leaking their value', () => {
    const error = normalizeError({ secret: 'must-not-render' });
    expect(error.code).toBe('runtime_error');
    expect(error.message).toBe('Unexpected error');
  });
});
