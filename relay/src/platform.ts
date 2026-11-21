// Contract:
// The adapter needs only this platform surface. Keep it independent of ambient
// Worker types so root tests can type-check without the relay package installed.
// worker.ts checks these interfaces against the real Cloudflare declarations.
export interface RelaySocket {
  readonly readyState: number;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

type SqlValue = string | number | null | ArrayBuffer;
export interface RelaySqlStorage {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string, ...bindings: SqlValue[]
  ): { toArray(): T[] };
}

export interface RelayContext {
  getWebSockets(): RelaySocket[];
  acceptWebSocket(socket: RelaySocket): void;
  storage: {
    sql: RelaySqlStorage;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

export interface RelayPlatform {
  WebSocketPair: new () => { 0: RelaySocket; 1: RelaySocket };
}
