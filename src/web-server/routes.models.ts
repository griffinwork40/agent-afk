/** Authenticated model catalogue for the web surface; no provider requests. */
import type { ServerResponse } from 'node:http';
import { sendJson } from './routes.js';
import { buildFlatModelList, buildModelGroups } from './model-catalog-groups.js';

export interface ModelInfo {
  id: string;
  label: string;
}

/** `default` is the owner's launch model, not a browser-side guess. */
export function handleListModels(res: ServerResponse, defaultModel?: string): void {
  const models = buildFlatModelList(defaultModel);
  const groups = buildModelGroups(defaultModel);
  sendJson(res, 200, {
    models,
    groups,
    default: defaultModel,
  });
}
