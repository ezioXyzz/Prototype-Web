# EzioCloud — Cloud File Manager

EzioCloud is a Cloudflare Workers, D1, and R2 file-manager starter with a dark graphite interface, neon-lime highlights, glass panels, and an animated orbit centerpiece inspired by the supplied visual reference. The screen includes file search, upload progress, file metadata, download, and delete controls. The footer credits **imira_H**.

Durable file bytes are sent to the configured Telegram bot storage chat. R2 is used only as temporary multipart staging during an upload; after Telegram accepts the file, the staged R2 object is deleted. D1 stores the file index and active transfer metadata.

## Important file-size / hosting constraints

The app targets **2,000,000,000 bytes per file** and sends uploads to a Telegram **local Bot API server**. Telegram documents local-mode uploads up to 2000 MB. The regular hosted Bot API does not support this upload size.

Cloudflare Free and Pro plans limit incoming request bodies to 100 MB. The browser therefore sends 64 MiB chunks through the Worker into an R2 multipart object. When the upload is complete, the Worker streams that R2 object to the self-hosted Telegram Bot API. The complete 2 GB file is not sent as one incoming Worker request and is not kept permanently in R2.

A Cloudflare account with Workers, a D1 database, an R2 bucket, and the Telegram local Bot API endpoint is required. Actual transfer success depends on the Bot API host and network supporting the full streamed request and response. Test with small files first, then a large file before relying on this for important data.

## Telegram setup

1. Create a private Telegram channel for the stored files, or use a dedicated private chat.
2. Add the bot to that destination. For a channel, make it an administrator with permission to post and delete messages.
3. Use the HTTPS base URL of your self-hosted Bot API server. The bot's public `t.me` link is not an API endpoint.
4. The app calls `sendDocument`, `getFile`, and `deleteMessage`. Keep the bot token private and do not expose it in browser code.

## Cloudflare deployment

Install Node.js and npm, then from this project directory:

```sh
npm install
npx wrangler login
npx wrangler d1 create eziocloud-db
npx wrangler r2 bucket create eziocloud-staging
```

Copy the D1 database ID returned by Wrangler into `wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`. The created R2 bucket name must match the name in that file.

Apply the migration:

```sh
npm run db:remote
```

Set the required secrets. Use the base URL of the self-hosted local Bot API server, with HTTPS:

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_API_BASE
npx wrangler secret put TELEGRAM_STORAGE_CHAT_ID
```

Generate a long random value for `SESSION_SECRET`. `TELEGRAM_STORAGE_CHAT_ID` should be the numeric chat/channel ID where the bot stores files. Do not commit real credentials, session secrets, or bot tokens.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in test values, and apply the local migration before starting Wrangler:

```sh
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Deploy with:

```sh
npm run deploy
```

## Current authentication scope

The current starter still uses a deployment-wide `APP_PASSWORD` and one shared file index. It does **not** yet implement individual user accounts, registration, or per-user file isolation. The EzioCloud sign-in screen is styled and functional with that existing access model; do not present this build as a multi-user service until account-based authentication and ownership checks have been added.

## Current limitations / setup notes

- Local Bot API servers can return absolute local file paths from `getFile`. The download route also tries the server's `/file/bot…` endpoint. Verify download behavior with your particular self-hosted Bot API server; if it only exposes files through its local filesystem, it will need a small authenticated download proxy on the same host.
- Deleting an item from this app calls Telegram's `deleteMessage`. Telegram can reject deletion of older messages (typically those older than 48 hours), in which case the file remains in Telegram and the app keeps its index entry.
- Interrupted multipart sessions may need cleanup from the R2 dashboard. Configure an R2 lifecycle rule to abort incomplete multipart uploads and expire old objects under the `staging/` prefix.
- There is no automatic reconciliation if messages are manually deleted or moved in Telegram.

## References

- [Telegram local Bot API server: 2000 MB upload capability](https://core.telegram.org/bots/api#using-a-local-bot-api-server)
- [Cloudflare Workers request-size limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2 multipart upload limits](https://developers.cloudflare.com/r2/platform/limits/)
