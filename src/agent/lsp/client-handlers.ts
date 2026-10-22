/**
 * Server-to-client request handling and client capabilities for `LspClient`.
 *
 * Invariant: every server-to-client request gets an answer. Servers such as
 * pyright block on `workspace/configuration` and stall forever if the client
 * never replies, so unknown methods are answered with `null`, never ignored.
 *
 * @module agent/lsp/client-handlers
 */

import type { ServerDefinition } from './server-spec.js';

/** Answer one server-to-client request. Never throws. */
export function answerServerRequest(
  definition: ServerDefinition,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case 'workspace/configuration': {
      const items = (params as { items?: Array<{ section?: string }> } | undefined)?.items ?? [];
      return items.map((item) => {
        const section = item?.section;
        if (typeof section !== 'string') return null;
        return definition.settings?.[section] ?? null;
      });
    }
    case 'workspace/applyEdit':
      return { applied: false };
    case 'window/workDoneProgress/create':
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    default:
      return null;
  }
}

/** Client capabilities: definition/references/diagnostics now, refactors later. */
export const CLIENT_CAPABILITIES = {
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: true },
    symbol: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    rename: { dynamicRegistration: false, prepareSupport: true },
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source', 'source.organizeImports'] },
      },
    },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
  },
  window: { workDoneProgress: true },
  general: { positionEncodings: ['utf-16'] },
} as const;
