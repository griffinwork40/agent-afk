import { afterEach, describe, expect, it, vi } from 'vitest';
import { elicitationRouter } from '../../elicitation-router.js';
import { lspInstallContext } from './lsp-install-consent.js';

vi.mock('../../elicitation-router.js', () => ({
  elicitationRouter: { hasHandler: vi.fn(), route: vi.fn() },
}));

afterEach(() => vi.resetAllMocks());

describe('LSP install human consent', () => {
  it('requires an explicit trusted dispatcher grant even if a parent router exists', () => {
    vi.mocked(elicitationRouter.hasHandler).mockReturnValue(true);
    expect(lspInstallContext().interactive).toBe(false);
    expect(lspInstallContext({ lspInstallAllowed: false }).askConsent).toBeUndefined();
    expect(elicitationRouter.route).not.toHaveBeenCalled();
  });

  it('requires a handler for this session, not an unrelated concurrent task', () => {
    vi.mocked(elicitationRouter.hasHandler).mockImplementation(key => key === 'other');
    expect(lspInstallContext({ lspInstallAllowed: true, sessionId: 'mine' }).interactive).toBe(false);
    expect(lspInstallContext({ lspInstallAllowed: true }).interactive).toBe(false);
    expect(elicitationRouter.hasHandler).toHaveBeenLastCalledWith('');
  });

  it.each([
    [{ action: 'accept', content: { value: true } }, true],
    [{ action: 'accept', content: { value: false } }, false],
    [{ action: 'accept', content: { value: 'yes' } }, false],
    [{ action: 'accept' }, false],
    [{ action: 'decline' }, false],
    [{ action: 'cancel' }, false],
  ] as const)('only explicit boolean approval authorizes installation: %j', async (response, expected) => {
    vi.mocked(elicitationRouter.hasHandler).mockReturnValue(true);
    vi.mocked(elicitationRouter.route).mockResolvedValue(response);
    const signal = new AbortController().signal;
    const ctx = lspInstallContext({ lspInstallAllowed: true, sessionId: 'mine' }, signal);
    expect(ctx.interactive).toBe(true);
    expect(await ctx.askConsent!('Install packages here?')).toBe(expected);
    expect(elicitationRouter.route).toHaveBeenCalledWith(expect.objectContaining({
      type: 'confirm', message: 'Install packages here?', questionDefault: false,
    }), { signal, sessionId: 'mine', sessionKey: 'mine' });
  });

  it('does not accept a response after cancellation', async () => {
    vi.mocked(elicitationRouter.hasHandler).mockReturnValue(true);
    const controller = new AbortController();
    vi.mocked(elicitationRouter.route).mockImplementation(async () => {
      controller.abort();
      return { action: 'accept', content: { value: true } };
    });
    const ctx = lspInstallContext({ lspInstallAllowed: true }, controller.signal);
    expect(await ctx.askConsent!('Install?')).toBe(false);
  });
});
