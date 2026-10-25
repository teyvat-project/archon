import { describe, expect, test, vi } from 'vitest';
import { ArchonError, Diagnostics } from '../src/diagnostics.js';

describe('Diagnostics', () => {
  test('error throws ArchonError with code and pointer', () => {
    const d = new Diagnostics();
    let caught: unknown;
    try {
      d.error('E_BAD', 'boom', '#/paths/~1x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArchonError);
    expect(caught).toMatchObject({ code: 'E_BAD', pointer: '#/paths/~1x', message: 'boom' });
    expect(d.entries).toEqual([{ level: 'error', code: 'E_BAD', message: 'boom', pointer: '#/paths/~1x' }]);
  });

  test('info is recorded but not sunk unless verbose', () => {
    const quiet = vi.fn();
    const q = new Diagnostics({ sink: quiet });
    q.info('I', 'hello');
    expect(q.entries).toHaveLength(1);
    expect(quiet).not.toHaveBeenCalled();

    const loud = vi.fn();
    const v = new Diagnostics({ verbose: true, sink: loud });
    v.info('I', 'hello');
    expect(loud).toHaveBeenCalledWith({ level: 'info', code: 'I', message: 'hello' });
  });

  test('warn and error always reach the sink; hasWarnings reflects warn entries', () => {
    const sink = vi.fn();
    const d = new Diagnostics({ sink });
    expect(d.hasWarnings()).toBe(false);
    d.warn('W', 'careful', '#/x');
    expect(d.hasWarnings()).toBe(true);
    expect(sink).toHaveBeenCalledWith({ level: 'warn', code: 'W', message: 'careful', pointer: '#/x' });
    expect(() => d.error('E', 'bad')).toThrow(ArchonError);
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
