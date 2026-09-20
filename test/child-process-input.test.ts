import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { endChildInput } from '../scripts/child-process-input';

class FailingInput extends EventEmitter {
  constructor(private readonly error: NodeJS.ErrnoException) {
    super();
  }

  end(): this {
    this.emit('error', this.error);
    return this;
  }
}

describe('child process input', () => {
  it('treats an early child exit as a process result instead of an unhandled EPIPE', () => {
    const report = vi.fn();
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    endChildInput(new FailingInput(error) as unknown as Writable, 'request', report);

    expect(report).not.toHaveBeenCalled();
  });

  it('reports unexpected stdin failures to the dispatcher', () => {
    const report = vi.fn();
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    endChildInput(new FailingInput(error) as unknown as Writable, 'request', report);

    expect(report).toHaveBeenCalledWith(error);
  });
});
