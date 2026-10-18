import type { MediaStore } from "../media/store.js";

export type LoginStep = "awaiting_code" | "awaiting_password" | "ok";

export interface TelegramStatus {
  configured: boolean;
  authorized: boolean;
  channel: { set: boolean; id: string | null; title: string | null };
  account: { id: string; username: string | null; firstName: string | null } | null;
  storeReady: boolean;
  lastError?: string;
}

// The full Telegram capability surface used by the HTTP layer. Kept separate
// from HTTP so tests can substitute a fake.
export interface TelegramBackend extends MediaStore {
  getStatus(): Promise<TelegramStatus>;
  startLogin(input: { phone: string; apiId?: number; apiHash?: string }): Promise<{ loginId: string; step: LoginStep }>;
  submitCode(loginId: string, code: string, phone?: string): Promise<{ step: LoginStep }>;
  submitPassword(loginId: string, password: string): Promise<{ step: LoginStep }>;
  setChannel(channel?: string): Promise<{ id: string; title: string | null }>;
  logoutTelegram(): Promise<void>;
}
