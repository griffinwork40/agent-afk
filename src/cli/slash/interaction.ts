/** Surface-neutral, JSON-safe interaction messages for slash commands. */
export interface ChoiceRequest {
  corrId: string;
  title: string;
  options: readonly { value: string; label: string; description?: string }[];
  default?: string;
  cancellable?: boolean;
}

/** Null means cancelled; selected values must come from request.options. */
export type Choose = (request: ChoiceRequest) => Promise<string | null>;

export interface ProgressEvent {
  corrId: string;
  phase: 'start' | 'update' | 'end';
  label: string;
  /** Normalized progress between 0 and 1 when known. */
  fraction?: number;
}
