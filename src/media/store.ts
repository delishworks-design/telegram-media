// Storage abstraction. TelegramService implements it for production; tests use
// an in-memory FakeMediaStore so auth, upload and range logic can be exercised
// without any network or credentials.

export interface UploadInput {
  path: string;
  name: string;
  mime: string;
  size: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  onProgress?: (fraction: number, bytesSent: number) => void;
  signal?: AbortSignal;
}

export interface StoredMedia {
  messageId: number;
  channelId: string;
  size: number;
  mime: string;
  duration?: number;
  width?: number;
  height?: number;
  fileReference?: string;
}

export interface MessageRef {
  channelId: string;
  messageId: number;
}

export interface MediaStore {
  readonly kind: string;
  /** Resolves true when the store can accept uploads and serve reads. */
  ready(): Promise<boolean>;
  upload(input: UploadInput): Promise<StoredMedia>;
  /** Yields buffers for the inclusive byte range [start, end]. */
  readRange(ref: MessageRef, start: number, end: number, signal?: AbortSignal): AsyncIterable<Buffer>;
  delete(ref: MessageRef): Promise<void>;
  /** Human sentence shown before a delete is confirmed. */
  describeDelete(): string;
}
