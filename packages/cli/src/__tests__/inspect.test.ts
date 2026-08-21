/**
 * Inspect command tests
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { inspectCommand } from '../commands/inspect.js';

/**
 * Exit-code contract for `inspect`:
 *   0 - server reached and healthy
 *   1 - server reached but unreachable/unhealthy
 *   2 - fatal error (invalid arguments, inspection threw)
 *
 * `process.exit` is stubbed to THROW rather than to return. The real
 * `process.exit` never returns, so a stub that returns normally would let
 * execution fall through into the request path and test a state the command
 * can never actually be in.
 */
class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe('inspect command', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExit(code);
    }) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('missing --url argument', () => {
    it('exits with code 2, not 1', async () => {
      await expect(inspectCommand([])).rejects.toThrow(ProcessExit);

      expect(exitSpy).toHaveBeenCalledWith(2);
      // 1 means "server unreachable/unhealthy". Reporting a usage error that
      // way is the bug this test pins: callers cannot tell the two apart.
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it('exits with code 2 when other flags are given but --url is absent', async () => {
      await expect(inspectCommand(['--json', '--tool', 'listPets'])).rejects.toThrow(ProcessExit);

      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it('exits with code 2 when --url is passed with no value', async () => {
      await expect(inspectCommand(['--url'])).rejects.toThrow(ProcessExit);

      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it('explains what is missing before exiting', async () => {
      await expect(inspectCommand([])).rejects.toThrow(ProcessExit);

      const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('--url');
      expect(output).toContain('Usage:');
    });

    it('does not attempt to reach a server when --url is missing', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');

      await expect(inspectCommand([])).rejects.toThrow(ProcessExit);

      // A usage error must fail before any network work is attempted —
      // otherwise the 1-vs-2 distinction is meaningless.
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  // TODO: Add integration tests once a local test server is available
  // - Test against running Petstore server
  // - Test against unreachable server (timeout handling)
  // - Test dry-run execution
  // - Test diff against snapshot
});
