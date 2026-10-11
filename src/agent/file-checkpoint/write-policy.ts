/** Current write-policy adapters for rewind and validated canonical snapshots. */
import type { ToolHandlerContext } from '../tools/types.js';
import { realpathSafe, resolveAndContain } from '../tools/handlers/_cwd-utils.js';
import { assertNotDenylisted } from '../tools/handlers/write-denylist.js';
import { resolveWriteTarget } from '../tools/handlers/write-file.atomic.js';

export async function validatedWriteTarget(
  path: string, context: ToolHandlerContext | undefined, cwd?: string,
): Promise<string> {
  const absolute = resolveAndContain(path, context, 'write', cwd);
  assertNotDenylisted(absolute, 'file checkpoint');
  const target = realpathSafe(await resolveWriteTarget(absolute));
  resolveAndContain(target, context, 'write', cwd);
  assertNotDenylisted(target, 'file checkpoint');
  return target;
}

/** Read grants at rewind time, not from the historical snapshot. */
export function currentWritePolicy(dispatcher: object | undefined, fallback: ToolHandlerContext): ToolHandlerContext {
  if (dispatcher && 'getGrants' in dispatcher && typeof dispatcher.getGrants === 'function') {
    return (dispatcher.getGrants as () => ToolHandlerContext)();
  }
  return fallback;
}
