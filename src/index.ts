export interface Env {
  DB: D1Database;
  STAGING: R2Bucket;
  ASSETS: Fetcher;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_API_BASE: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  MAX_FILE_BYTES?: string;
}

const COOKIE_NAME = "fm_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_MAX_FILE_BYTES = 2_000_000_000;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const encoder = new TextEncoder();

interface UploadRow {
  id: string;
  object_key: string;
  multipart_id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  status: "uploading" | "staged" | "finalizing";
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json; charset=utf-8");
  out.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: out });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return mismatch === 0;
}

function cookieValue(request: Request, name: string): string | null {
  const source = request.headers.get("cookie") ?? "";
  for (const part of source.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function makeSession(secret: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = String(expiresAt);
  return `${payload}.${base64Url(await hmac(secret, payload))}`;
}

async function hasSession(request: Request, env: Env): Promise<boolean> {
  const value = cookieValue(request, COOKIE_NAME);
  if (!value) return false;
  const [expiresText, signature, extra] = value.split(".");
  const expiresAt = Number(expiresText);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !signature) return false;
  return constantTimeEqual(signature, base64Url(await hmac(env.SESSION_SECRET, expiresText)));
}

function sessionCookie(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\r\n\u0000-\u001f\u007f]/g, "_").replaceAll('"', "'").trim().slice(0, 255);
}

function maxFileBytes(env: Env): number {
  const configured = Number(env.MAX_FILE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_BYTES;
}

function getBotBase(env: Env): string {
  const base = env.TELEGRAM_API_BASE?.trim();
  if (!base) throw new Error("TELEGRAM_API_BASE is not configured.");
  const parsed = new URL(base);
  if (parsed.protocol !== "https:") throw new Error("TELEGRAM_API_BASE must use HTTPS.");
  return base.replace(/\/+$/, "");
}

function botMethodUrl(env: Env, method: string): string {
  return `${getBotBase(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramMethod<T>(env: Env, method: string, payload: unknown): Promise<T> {
  const response = await fetch(botMethodUrl(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok || body.result === undefined) {
    throw new Error(body?.description || `Telegram ${method} failed (HTTP ${response.status}).`);
  }
  return body.result;
}

function multipartDocumentBody(
  chatId: string,
  fileName: string,
  mimeType: string,
  fileBody: ReadableStream<Uint8Array>,
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = `----CloudFileManager${crypto.randomUUID().replaceAll("-", "")}`;
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFileName(fileName)}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = fileBody.getReader();
  let phase: "prefix" | "file" | "suffix" | "done" = "prefix";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (phase === "prefix") {
          phase = "file";
          controller.enqueue(prefix);
          return;
        }
        if (phase === "file") {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          phase = "suffix";
        }
        if (phase === "suffix") {
          phase = "done";
          controller.enqueue(suffix);
          controller.close();
          return;
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const lengthText = request.headers.get("content-length");
  const length = Number(lengthText);
  if (!request.body || !Number.isSafeInteger(length) || length < 1 || length > MAX_PART_BYTES) {
    return error("Each upload part must be between 1 byte and 64 MiB.", 413);
  }
  const match = new URL(request.url).pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/parts\/(\d+)$/i);
  if (!match) return error("Invalid upload part route.", 404);
  const uploadId = match[1]!;
  const partNumber = Number(match[2]);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) return error("Invalid part number.");
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first<UploadRow>();
  if (!upload || upload.status !== "uploading") return error("Upload session was not found or is no longer active.", 404);
  const expectedParts = Math.ceil(upload.file_size / MAX_PART_BYTES);
  if (partNumber > expectedParts) return error("Part number exceeds the expected upload size.");
  const start = (partNumber - 1) * MAX_PART_BYTES;
  const expectedLength = Math.min(MAX_PART_BYTES, upload.file_size - start);
  if (length !== expectedLength) {
    return error(`Part ${partNumber} had ${length} bytes; expected ${expectedLength}.`, 400);
  }
  const previous = await env.DB.prepare("SELECT part_number FROM upload_parts WHERE upload_id = ? AND part_number = ?")
    .bind(uploadId, partNumber).first<{ part_number: number }>();
  const multipart = env.STAGING.resumeMultipartUpload(upload.object_key, upload.multipart_id);
  const part = await multipart.uploadPart(partNumber, request.body);
  await env.DB.prepare(
    "INSERT INTO upload_parts (upload_id, part_number, etag) VALUES (?, ?, ?) ON CONFLICT(upload_id, part_number) DO UPDATE SET etag = excluded.etag",
  ).bind(uploadId, partNumber, part.etag).run();
  return json({ partNumber, etag: part.etag, replaced: Boolean(previous) });
}

async function cancelUpload(uploadId: string, env: Env): Promise<Response> {
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first<UploadRow>();
  if (!upload) return json({ ok: true });
  if (upload.status === "uploading") {
    await env.STAGING.resumeMultipartUpload(upload.object_key, upload.multipart_id).abort();
  } else if (upload.status === "staged") {
    await env.STAGING.delete(upload.object_key);
  } else {
    return error("This upload is being sent to Telegram and cannot be cancelled safely.", 409);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(uploadId),
    env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(uploadId),
  ]);
  return json({ ok: true });
}

async function handleUploadFinish(uploadId: string, env: Env): Promise<Response> {
  const upload = await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(uploadId).first<UploadRow>();
  if (!upload) return error("Upload session was not found.", 404);
  if (upload.status === "finalizing") return error("This upload is already being finalized.", 409);
  const partsResult = await env.DB.prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number")
    .bind(uploadId).all<{ part_number: number; etag: string }>();
  const parts = partsResult.results;
  const expectedCount = Math.ceil(upload.file_size / MAX_PART_BYTES);
  if (parts.length !== expectedCount || parts.some((part, index) => part.part_number !== index + 1)) {
    return error("The upload is incomplete; one or more chunks are missing.", 409);
  }
  if (upload.status === "uploading") {
    const multipart = env.STAGING.resumeMultipartUpload(upload.object_key, upload.multipart_id);
    await multipart.complete(parts.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    await env.DB.prepare("UPDATE uploads SET status = 'staged' WHERE id = ?").bind(uploadId).run();
  }
  await env.DB.prepare("UPDATE uploads SET status = 'finalizing' WHERE id = ? AND status = 'staged'").bind(uploadId).run();
  try {
    const staged = await env.STAGING.get(upload.object_key);
    if (!staged?.body) throw new Error("The staged upload could not be read from R2.");
    const form = multipartDocumentBody(env.TELEGRAM_STORAGE_CHAT_ID, upload.file_name, upload.mime_type, staged.body);
    const response = await fetch(botMethodUrl(env, "sendDocument"), {
      method: "POST",
      headers: { "content-type": form.contentType },
      body: form.body,
    });
    const body = await response.json().catch(() => null) as TelegramResponse<Record<string, unknown>> | null;
    if (!response.ok || !body?.ok || !body.result) {
      throw new Error(body?.description || `Telegram sendDocument failed (HTTP ${response.status}).`);
    }
    const message = body.result;
    const document = message.document as Record<string, unknown> | undefined;
    const messageId = Number(message.message_id);
    const chat = message.chat as Record<string, unknown> | undefined;
    if (!document || typeof document.file_id !== "string" || !Number.isSafeInteger(messageId)) {
      throw new Error("Telegram accepted the file but returned incomplete document metadata.");
    }
    const fileId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO files (id, file_name, mime_type, file_size, telegram_file_id, telegram_file_unique_id, telegram_message_id, telegram_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      fileId,
      upload.file_name,
      upload.mime_type,
      upload.file_size,
      document.file_id,
      typeof document.file_unique_id === "string" ? document.file_unique_id : null,
      messageId,
      String(chat?.id ?? env.TELEGRAM_STORAGE_CHAT_ID),
    ).run();
    try {
      await env.STAGING.delete(upload.object_key);
    } catch (cleanupError) {
      console.warn("[File Manager] Telegram copy succeeded but temporary R2 cleanup failed.", cleanupError);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(uploadId),
      env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(uploadId),
    ]);
    return json({ id: fileId, name: upload.file_name, size: upload.file_size, mimeType: upload.mime_type }, 201);
  } catch (cause) {
    await env.DB.prepare("UPDATE uploads SET status = 'staged' WHERE id = ? AND status = 'finalizing'").bind(uploadId).run();
    const message = cause instanceof Error ? cause.message : "Telegram upload failed.";
    return error(message, 502);
  }
}

async function handleDownload(id: string, env: Env): Promise<Response> {
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<{
    id: string; file_name: string; mime_type: string; file_size: number; telegram_file_id: string;
  }>();
  if (!file) return error("File not found.", 404);
  const result = await telegramMethod<{ file_path?: string; file_size?: number }>(env, "getFile", { file_id: file.telegram_file_id });
  if (!result.file_path) return error("Telegram did not return a downloadable file path.", 502);
  const path = result.file_path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${getBotBase(env)}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!response.ok || !response.body) return error(`Telegram file download failed (HTTP ${response.status}).`, 502);
  const dispositionName = safeFileName(file.file_name).replaceAll('"', "'");
  return new Response(response.body, {
    status: 200,
    headers: {
      "content-type": file.mime_type || "application/octet-stream",
      "content-length": String(file.file_size),
      "content-disposition": `attachment; filename="${dispositionName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/health" && request.method === "GET") return json({ ok: true });
  if (pathname === "/api/auth/login" && request.method === "POST") {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return error("Authentication secrets are not configured.", 503);
    const input = await request.json().catch(() => null) as { password?: string } | null;
    if (!input?.password || !constantTimeEqual(input.password, env.APP_PASSWORD)) return error("Incorrect password.", 401);
    const session = await makeSession(env.SESSION_SECRET);
    const secure = new URL(request.url).protocol === "https:";
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(session, secure) });
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const secure = new URL(request.url).protocol === "https:";
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}` });
  }
  if (!(await hasSession(request, env))) return error("Sign in to continue.", 401);
  if (pathname === "/api/auth/me" && request.method === "GET") return json({ ok: true, maxFileBytes: maxFileBytes(env) });
  if (pathname === "/api/files" && request.method === "GET") {
    const term = new URL(request.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
    const result = term
      ? await env.DB.prepare("SELECT id, file_name AS name, mime_type AS mimeType, file_size AS size, created_at AS createdAt FROM files WHERE instr(lower(file_name), lower(?)) > 0 ORDER BY created_at DESC LIMIT 500")
        .bind(term).all()
      : await env.DB.prepare("SELECT id, file_name AS name, mime_type AS mimeType, file_size AS size, created_at AS createdAt FROM files ORDER BY created_at DESC LIMIT 500").all();
    const summary = await env.DB.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(file_size), 0) AS bytes FROM files").first<{ count: number; bytes: number }>();
    return json({ files: result.results, summary: summary ?? { count: 0, bytes: 0 } });
  }
  if (pathname === "/api/uploads/init" && request.method === "POST") {
    const input = await request.json().catch(() => null) as { name?: string; size?: number; mimeType?: string } | null;
    const name = safeFileName(input?.name ?? "");
    const size = Number(input?.size);
    const mimeType = input?.mimeType || "application/octet-stream";
    if (!name || !Number.isSafeInteger(size) || size < 1 || size > maxFileBytes(env)) {
      return error(`Choose a file from 1 byte to ${maxFileBytes(env).toLocaleString()} bytes.`, 413);
    }
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) || mimeType.length > 180) return error("Invalid file type.");
    const id = crypto.randomUUID();
    const key = `staging/${id}`;
    const multipart = await env.STAGING.createMultipartUpload(key, { httpMetadata: { contentType: mimeType } });
    await env.DB.prepare(
      "INSERT INTO uploads (id, object_key, multipart_id, file_name, mime_type, file_size, status) VALUES (?, ?, ?, ?, ?, ?, 'uploading')",
    ).bind(id, key, multipart.uploadId, name, mimeType, size).run();
    return json({ uploadId: id, partSize: MAX_PART_BYTES, minPartSize: MIN_PART_BYTES });
  }
  if (pathname.match(/^\/api\/uploads\/[a-f0-9-]{36}\/parts\/\d+$/i) && request.method === "PUT") return handleUpload(request, env);
  const finishMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/finish$/i);
  if (finishMatch && request.method === "POST") return handleUploadFinish(finishMatch[1]!, env);
  const cancelMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/cancel$/i);
  if (cancelMatch && request.method === "POST") return cancelUpload(cancelMatch[1]!, env);
  const downloadMatch = pathname.match(/^\/api\/files\/([a-f0-9-]{36})\/download$/i);
  if (downloadMatch && request.method === "GET") return handleDownload(downloadMatch[1]!, env);
  const deleteMatch = pathname.match(/^\/api\/files\/([a-f0-9-]{36})$/i);
  if (deleteMatch && request.method === "DELETE") {
    const file = await env.DB.prepare("SELECT telegram_message_id, telegram_chat_id FROM files WHERE id = ?")
      .bind(deleteMatch[1]).first<{ telegram_message_id: number; telegram_chat_id: string }>();
    if (!file) return error("File not found.", 404);
    await telegramMethod(env, "deleteMessage", { chat_id: file.telegram_chat_id, message_id: file.telegram_message_id });
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(deleteMatch[1]).run();
    return json({ ok: true });
  }
  return error("Not found.", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Unexpected server error.";
        console.error("[File Manager]", message);
        return error(message, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
