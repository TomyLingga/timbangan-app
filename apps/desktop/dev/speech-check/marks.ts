// What the speech check page records and the main process reports. Types only, shared by page, main and runner.

export type MarkKind =
  | "context" // an AudioContext was created; value: its state at creation
  | "state" // its state changed; value: the new state
  | "speaking" // the queue shows a segment (onSpeaking)
  | "decoded" // decodeAudioData finished; value: duration in seconds
  | "start" // a buffer source started
  | "ended" // that buffer source fired `ended` (the event audio.ts waits for with onended)
  | "tone-start"
  | "tone-end"
  | "idle" // the queue is idle after the round
  | "timeout"; // the queue did not get idle in time

export interface Mark {
  /** ms since the page loaded (performance.now in the window) */
  at: number;
  kind: MarkKind;
  round: number;
  /** index of the segment in the round, null when none is being spoken */
  segment: number | null;
  value?: string | number;
}

export interface PageResult {
  marks: Mark[];
  /** state of every AudioContext at the end */
  contextStates: string[];
  /** navigator.userActivation: whether anything in the window was ever clicked or typed */
  hasBeenActive: boolean | null;
}

export interface FetchRecord {
  round: number;
  text: string;
  /** ms from the IPC request in the main process until the audio (or null) was ready */
  ms: number;
  bytes: number | null;
  /** HTTP status of the speech route; null when no request was made or it failed on the network */
  status: number | null;
}

export interface CheckOutput {
  apiBaseUrl: string;
  audible: boolean;
  autoplayPolicy: string;
  rounds: string[][];
  fetches: FetchRecord[];
  page: PageResult | null;
  console: string[];
  error?: string;
}
