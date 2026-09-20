import type { Writable } from 'node:stream';

const CLOSED_PIPE_ERRORS = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

export function endChildInput(
  stream: Writable | null,
  input: string,
  onUnexpectedError: (error: NodeJS.ErrnoException) => void,
): void {
  if (!stream) return;
  const handleError = (error: NodeJS.ErrnoException) => {
    if (!CLOSED_PIPE_ERRORS.has(error.code ?? '')) onUnexpectedError(error);
  };
  stream.on('error', handleError);
  try {
    stream.end(input);
  } catch (error) {
    handleError(error as NodeJS.ErrnoException);
  }
}
