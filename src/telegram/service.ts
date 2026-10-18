import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { computeCheck } from "teleproto/Password.js";
import { CustomFile } from "teleproto/client/uploads.js";
import { randomToken, SecretBox } from "../util/crypto.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/index.js";
import type { Logger } from "../util/logger.js";
import type {
  MediaStore,
  MessageRef,
  StoredMedia,
  UploadInput,
} from "../media/store.js";
import type { LoginStep, TelegramBackend, TelegramStatus } from "./types.js";

export class NotConfiguredError extends Error {
  constructor(message = "Telegram account is not configured") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class TelegramFloodError extends Error {
  constructor(
    public readonly seconds: number,
    message: string,
  ) {
    super(message);
    this.name = "TelegramFloodError";
  }
}

interface ConfigRow {
  api_id: number | null;
  api_hash_enc: string | null;
  phone: string | null;
  channel_id: string | null;
  channel_title: string | null;
  channel_access_hash: string | null;
}

interface LoginState {
  phoneCodeHash: string;
  phone: string;
}

function isPasswordNeeded(err: unknown): boolean {
  const msg = errMessage(err);
  return /SESSION_PASSWORD_NEEDED|PASSWORD_NEEDED/i.test(msg);
}

function errMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { errorMessage?: string; message?: string };
    return e.errorMessage ?? e.message ?? "";
  }
  return "";
}

export function floodWaitSeconds(err: unknown): number {
  const m = /FLOOD_WAIT_(\d+)/i.exec(errMessage(err));
  return m ? Number(m[1]) : 0;
}

function clampRequestSize(bytes: number): number {
  const cap = Math.min(bytes, 1024 * 1024);
  const floor = 4096;
  return Math.max(floor, Math.floor(cap / floor) * floor);
}

export class TelegramService implements TelegramBackend, MediaStore {
  readonly kind = "telegram";
  private client: TelegramClient | null = null;
  private connecting: Promise<TelegramClient> | null = null;
  private streamChunkBytes: number;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly logger: Logger,
  ) {
    this.streamChunkBytes = clampRequestSize(config.streamChunkBytes);
  }

  // --- configuration persistence -------------------------------------------

  private configRow(): ConfigRow | undefined {
    return this.db
      .prepare("SELECT api_id, api_hash_enc, phone, channel_id, channel_title, channel_access_hash FROM telegram_config WHERE id = 1")
      .get() as ConfigRow | undefined;
  }

  private upsertConfig(patch: Partial<{
    apiId: number;
    apiHashEnc: string;
    phone: string;
    channelId: string;
    channelTitle: string;
    channelAccessHash: string;
  }>): void {
    const current = this.configRow();
    const next = {
      api_id: patch.apiId ?? current?.api_id ?? null,
      api_hash_enc: patch.apiHashEnc ?? current?.api_hash_enc ?? null,
      phone: patch.phone ?? current?.phone ?? null,
      channel_id: patch.channelId ?? current?.channel_id ?? null,
      channel_title: patch.channelTitle ?? current?.channel_title ?? null,
      channel_access_hash: patch.channelAccessHash ?? current?.channel_access_hash ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO telegram_config (id, api_id, api_hash_enc, phone, channel_id, channel_title, channel_access_hash, updated_at)
         VALUES (1, @api_id, @api_hash_enc, @phone, @channel_id, @channel_title, @channel_access_hash, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           api_id=@api_id, api_hash_enc=@api_hash_enc, phone=@phone,
           channel_id=@channel_id, channel_title=@channel_title,
           channel_access_hash=@channel_access_hash, updated_at=@updated_at`,
      )
      .run({ ...next, updated_at: Date.now() });
  }

  private resolvedCredentials(): { apiId: number; apiHash: string } {
    const row = this.configRow();
    const apiId = row?.api_id ?? this.config.telegram.apiId;
    let apiHash: string | undefined;
    if (row?.api_hash_enc) {
      apiHash = this.masterBox().open(row.api_hash_enc, "api-hash");
    } else if (this.config.telegram.apiHash) {
      apiHash = this.config.telegram.apiHash;
    }
    if (!apiId || !apiHash) throw new NotConfiguredError("Telegram api id / api hash are missing");
    return { apiId, apiHash };
  }

  private masterBox(): SecretBox {
    return new SecretBox(this.config.masterKey).subkey("telegram");
  }

  private getStoredSession(): string {
    const row = this.db.prepare("SELECT session_enc FROM telegram_session WHERE id = 1").get() as
      | { session_enc: string }
      | undefined;
    if (!row) return "";
    try {
      return this.masterBox().open(row.session_enc, "session");
    } catch (err) {
      this.logger.error("failed to decrypt stored Telegram session", { error: errMessage(err) });
      return "";
    }
  }

  private saveSession(session: string): void {
    this.db
      .prepare(
        `INSERT INTO telegram_session (id, session_enc, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET session_enc=excluded.session_enc, updated_at=excluded.updated_at`,
      )
      .run(this.masterBox().seal(session, "session"), Date.now());
  }

  private clearSession(): void {
    this.db.prepare("DELETE FROM telegram_session WHERE id = 1").run();
  }

  private saveLoginState(id: string, state: LoginState): void {
    this.db
      .prepare(
        `INSERT INTO telegram_login (id, state_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state_enc=excluded.state_enc, updated_at=excluded.updated_at`,
      )
      .run(id, this.masterBox().seal(JSON.stringify(state), "login"), Date.now());
  }

  private loadLoginState(id: string): LoginState | null {
    const row = this.db.prepare("SELECT state_enc FROM telegram_login WHERE id = ?").get(id) as
      | { state_enc: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(this.masterBox().open(row.state_enc, "login")) as LoginState;
    } catch {
      return null;
    }
  }

  private clearLoginState(id: string): void {
    this.db.prepare("DELETE FROM telegram_login WHERE id = ?").run(id);
  }

  // Seed from env on first boot (idempotent).
  seedFromEnv(): void {
    const row = this.configRow();
    if (row) return;
    const { apiId, apiHash, phone, channel, channelTitle } = this.config.telegram;
    if (apiId && apiHash) {
      this.upsertConfig({ apiId, apiHashEnc: this.masterBox().seal(apiHash, "api-hash") });
    }
    if (phone || channel || channelTitle) {
      this.upsertConfig({ phone, channelTitle });
    }
    if (channel) this.upsertConfig({ channelId: channel });
  }

  // --- client lifecycle -----------------------------------------------------

  private async ensureClient(): Promise<TelegramClient> {
    if (this.client && this.client.connected) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const { apiId, apiHash } = this.resolvedCredentials();
      const client = new TelegramClient(new StringSession(this.getStoredSession()), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        floodSleepThreshold: 120,
      });
      await client.connect();
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async requireAuthorized(): Promise<TelegramClient> {
    const client = await this.ensureClient();
    if (!(await client.isUserAuthorized())) {
      throw new NotConfiguredError("Telegram account is not signed in");
    }
    return client;
  }

  private peer(): Api.InputPeerChannel {
    const row = this.configRow();
    if (!row?.channel_id) throw new NotConfiguredError("No Telegram storage channel is set");
    return new Api.InputPeerChannel({
      channelId: bigInt(row.channel_id),
      accessHash: bigInt(row.channel_access_hash ?? "0"),
    });
  }

  ready(): boolean {
    const row = this.configRow();
    return Boolean(row?.channel_id) && Boolean(this.client?.connected);
  }

  async getStatus(): Promise<TelegramStatus> {
    const row = this.configRow();
    const status: TelegramStatus = {
      configured: Boolean(row?.api_id && row?.api_hash_enc) || Boolean(this.config.telegram.apiId),
      authorized: false,
      channel: {
        set: Boolean(row?.channel_id),
        id: row?.channel_id ?? null,
        title: row?.channel_title ?? null,
      },
      account: null,
      storeReady: false,
    };
    try {
      const client = await this.ensureClient();
      if (await client.isUserAuthorized()) {
        status.authorized = true;
        const me = await client.getMe();
        status.account = {
          id: String(me.id),
          username: me.username ?? null,
          firstName: me.firstName ?? null,
        };
        status.storeReady = Boolean(row?.channel_id);
      }
    } catch (err) {
      const msg = errMessage(err);
      if (!(err instanceof NotConfiguredError) && !/AUTH_KEY_UNREGISTERED|USER_DEACTIVATED/i.test(msg)) {
        this.logger.warn("telegram status check failed", { error: msg });
      }
      status.lastError = err instanceof NotConfiguredError ? "not_configured" : "unavailable";
    }
    return status;
  }

  // --- interactive login ----------------------------------------------------

  async startLogin(input: { phone: string; apiId?: number; apiHash?: string }): Promise<{ loginId: string; step: LoginStep }> {
    const phone = input.phone?.trim();
    if (!phone || !/^\+?\d{6,15}$/.test(phone.replace(/[\s-]/g, ""))) {
      throw new Error("A valid phone number in international format is required");
    }
    const apiId = input.apiId ?? this.configRow()?.api_id ?? this.config.telegram.apiId;
    const apiHash =
      input.apiHash ??
      (this.configRow()?.api_hash_enc
        ? this.masterBox().open(this.configRow()!.api_hash_enc!, "api-hash")
        : this.config.telegram.apiHash);
    if (!apiId || !apiHash) throw new NotConfiguredError("api id and api hash are required");

    if (input.apiId || input.apiHash) {
      this.upsertConfig({
        apiId,
        apiHashEnc: this.masterBox().seal(apiHash, "api-hash"),
      });
    }
    this.upsertConfig({ phone });

    // A fresh client on the current (probably empty) session.
    if (this.client) {
      await this.client.disconnect().catch(() => undefined);
      this.client = null;
    }
    const client = new TelegramClient(new StringSession(this.getStoredSession()), apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.connect();
    this.client = client;

    const result = await client.sendCode({ apiId, apiHash }, phone);
    const loginId = randomToken(18);
    this.saveLoginState(loginId, { phoneCodeHash: result.phoneCodeHash, phone });
    this.logger.info("telegram login code requested", { });
    return { loginId, step: "awaiting_code" };
  }

  async submitCode(loginId: string, code: string, phone?: string): Promise<{ step: LoginStep }> {
    const state = this.loadLoginState(loginId);
    if (!state) throw new Error("Login session expired or unknown; restart the login");
    const client = await this.ensureClient();
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone ?? state.phone,
          phoneCodeHash: state.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
    } catch (err) {
      if (isPasswordNeeded(err)) {
        return { step: "awaiting_password" };
      }
      throw err;
    }
    this.persistAuthorizedSession(client);
    this.clearLoginState(loginId);
    return { step: "ok" };
  }

  async submitPassword(loginId: string, password: string): Promise<{ step: LoginStep }> {
    const state = this.loadLoginState(loginId);
    if (!state) throw new Error("Login session expired or unknown; restart the login");
    const client = await this.ensureClient();
    const pwd = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(pwd, password);
    await client.invoke(new Api.auth.CheckPassword({ password: check }));
    this.persistAuthorizedSession(client);
    this.clearLoginState(loginId);
    return { step: "ok" };
  }

  private persistAuthorizedSession(client: TelegramClient): void {
    const session = client.session.save();
    if (!session) throw new Error("Telegram did not return a session string");
    this.saveSession(session);
    this.logger.info("telegram session persisted");
    // If a channel was pre-configured in env, resolve it now.
    if (!this.configRow()?.channel_id && this.config.telegram.channel) {
      void this.setChannel(this.config.telegram.channel).catch((err) =>
        this.logger.warn("could not auto-resolve configured channel", { error: errMessage(err) }),
      );
    }
  }

  async logoutTelegram(): Promise<void> {
    try {
      if (this.client) {
        await this.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
        await this.client.disconnect().catch(() => undefined);
      }
    } finally {
      this.client = null;
      this.clearSession();
      this.db.prepare("DELETE FROM telegram_login").run();
    }
  }

  // --- channel resolution ---------------------------------------------------

  async setChannel(channel?: string): Promise<{ id: string; title: string | null }> {
    const client = await this.requireAuthorized();
    const target = (channel ?? this.configRow()?.channel_id ?? this.config.telegram.channel ?? "").trim();

    let entity: Api.Channel;
    if (!target) {
      entity = await this.createPrivateChannel(client);
    } else {
      const resolved = await client.getEntity(target).catch(() => null);
      if (!resolved || !(resolved instanceof Api.Channel)) {
        throw new Error(
          "Could not resolve that channel. Use the @username of a channel you own, or leave it blank to create a new private one.",
        );
      }
      entity = resolved;
    }

    const id = String(entity.id);
    const accessHash = entity.accessHash ? String(entity.accessHash) : "0";
    const title = entity.title ?? null;
    this.upsertConfig({ channelId: id, channelAccessHash: accessHash, channelTitle: title ?? undefined });
    this.logger.info("telegram channel set", { channelId: id, title });
    return { id, title };
  }

  private async createPrivateChannel(client: TelegramClient): Promise<Api.Channel> {
    const updates = await client.invoke(
      new Api.channels.CreateChannel({
        title: this.config.telegram.channelTitle,
        about: "Private storage for the media library.",
        broadcast: true,
        megagroup: false,
      }),
    );
    const chats = (updates as Api.Updates).chats ?? [];
    const channel = chats.find((c): c is Api.Channel => c instanceof Api.Channel);
    if (!channel) throw new Error("Telegram did not return the created channel");
    return channel;
  }

  // --- MediaStore -----------------------------------------------------------

  describeDelete(): string {
    return "Deleting removes the row from this library and permanently deletes the file from your Telegram channel (the message is revoked for all participants). Standalone copies you saved elsewhere are unaffected.";
  }

  async upload(input: UploadInput): Promise<StoredMedia> {
    const client = await this.requireAuthorized();
    const peer = this.peer();

    const cb = ((progress: number) => {
      input.onProgress?.(progress, Math.floor(progress * input.size));
      if (input.signal?.aborted) {
        (cb as { isCanceled?: boolean }).isCanceled = true;
      }
    }) as ((progress: number) => void) & { isCanceled?: boolean };

    const isVideo = input.mime.startsWith("video/");
    const filenameAttr = new Api.DocumentAttributeFilename({ fileName: input.name });

    const send = async (attributes: Api.TypeDocumentAttribute[], stream: boolean, forceDocument: boolean) =>
      client.sendFile(peer, {
        file: new CustomFile(input.name, input.size, input.path),
        forceDocument,
        caption: input.name,
        attributes,
        supportsStreaming: stream,
        workers: 1,
        progressCallback: cb,
      });

    let message: Api.Message;
    if (isVideo) {
      const videoAttr = new Api.DocumentAttributeVideo({
        duration: Math.round(input.durationSeconds ?? 0),
        w: Math.round(input.width ?? 0),
        h: Math.round(input.height ?? 0),
        supportsStreaming: true,
      });
      try {
        message = await send([filenameAttr, videoAttr], true, false);
      } catch (err) {
        this.logger.warn("video send failed, retrying as document", { error: errMessage(err) });
        message = await send([filenameAttr], false, true);
      }
    } else {
      message = await send([filenameAttr], false, true);
    }

    const doc = message.document ?? (message.media as Api.MessageMediaDocument | undefined)?.document;
    const docObj = doc instanceof Api.Document ? doc : null;
    const size = docObj?.size ? Number(docObj.size) : input.size;
    const mime = docObj?.mimeType ?? input.mime;

    return {
      messageId: message.id,
      channelId: String(this.configRow()!.channel_id),
      size,
      mime,
      duration: input.durationSeconds,
      width: input.width,
      height: input.height,
      fileReference: docObj?.fileReference
        ? Buffer.from(docObj.fileReference).toString("base64")
        : undefined,
    };
  }

  private async fetchMessage(client: TelegramClient, ref: MessageRef): Promise<Api.Message> {
    const messages = await client.getMessages(this.peer(), { ids: [ref.messageId] });
    const message = messages[0];
    const doc =
      message?.document ??
      (message?.media as Api.MessageMediaDocument | undefined)?.document ??
      null;
    if (!(doc instanceof Api.Document)) {
      throw new Error("The stored Telegram message has no document to read");
    }
    return message!;
  }

  async *readRange(ref: MessageRef, start: number, end: number, signal?: AbortSignal): AsyncIterable<Buffer> {
    const client = await this.requireAuthorized();
    const length = end - start + 1;
    if (length <= 0) return;

    let message = await this.fetchMessage(client, ref);
    let remaining = length;
    let attempts = 0;

    while (remaining > 0) {
      try {
        for await (const chunk of client.iterDownload(message, {
          offset: start + (length - remaining),
          requestSize: this.streamChunkBytes,
          limit: remaining,
          signal,
        })) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
          remaining -= slice.length;
          yield slice;
          if (remaining <= 0) return;
        }
        return;
      } catch (err) {
        const msg = errMessage(err);
        if (signal?.aborted) return;
        if (/FILE_REFERENCE_EXPIRED/i.test(msg) && attempts < 1) {
          message = await this.fetchMessage(client, ref);
          attempts++;
          continue;
        }
        throw err;
      }
    }
  }

  async delete(ref: MessageRef): Promise<void> {
    const client = await this.requireAuthorized();
    await client.deleteMessages(this.peer(), [ref.messageId], { revoke: true });
  }
}
