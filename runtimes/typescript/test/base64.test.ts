import { describe, expect, it } from 'vitest';
import { base64Encode } from '../src/base64.js';

describe('base64Encode', () => {
  it('encodes UTF-8 text', () => {
    expect(base64Encode('user:päss')).toBe('dXNlcjpww6Rzcw==');
  });

  it('encodes the empty string', () => {
    expect(base64Encode('')).toBe('');
  });

  it('handles every padding length', () => {
    expect(base64Encode('f')).toBe('Zg==');
    expect(base64Encode('fo')).toBe('Zm8=');
    expect(base64Encode('foo')).toBe('Zm9v');
    expect(base64Encode('foobar')).toBe('Zm9vYmFy');
  });

  it('encodes characters outside the BMP', () => {
    expect(base64Encode('😀')).toBe('8J+YgA==');
  });
});
