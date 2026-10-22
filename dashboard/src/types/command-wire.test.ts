import { expectTypeOf, it } from 'vitest';
import type { CommandControl, CommandOutputBlock, CommandResponse } from './command-wire';
import type {
  CommandControl as ServerControl,
  CommandOutputBlock as ServerBlock,
  CommandResponse as ServerResponse,
} from '../../../src/web-server/shared/command-wire';

it('keeps the browser mirror assignable in both directions with structured blocks and controls', () => {
  expectTypeOf<CommandOutputBlock>().toExtend<ServerBlock>();
  expectTypeOf<ServerBlock>().toExtend<CommandOutputBlock>();
  expectTypeOf<CommandControl>().toEqualTypeOf<ServerControl>();
  expectTypeOf<CommandResponse>().toExtend<ServerResponse>();
  expectTypeOf<ServerResponse>().toExtend<CommandResponse>();
  expectTypeOf<Extract<CommandControl, { kind: 'clear' }>>().toEqualTypeOf<{ kind: 'clear' }>();
  expectTypeOf<NonNullable<CommandOutputBlock['kind']>>().toEqualTypeOf<
    'text' | 'table' | 'keyValue' | 'diff' | 'list' | 'link'
  >();
  expectTypeOf<NonNullable<CommandResponse['session']>>().toEqualTypeOf<{
    model?: string;
    name?: string;
    thinkingUi?: 'summary' | 'live' | 'digest' | 'off';
  }>();
});
