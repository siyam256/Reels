# Medilogy Poll Bot — Cloudflare Workers

This is a TypeScript/Cloudflare Workers migration starter for the Telegram MCQ poll bot.

## Before deployment
- Create a Cloudflare D1 database and run `schema.sql` against it.
- Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the database ID.
- Add Worker secrets: `BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET`.
- Keep all secrets out of GitHub.
- Set Telegram webhook to `https://YOUR-WORKER.workers.dev/webhook/WEBHOOK_SECRET`.

## Local setup
```sh
npm install
npx wrangler d1 create medilogy-poll-bot-db
npx wrangler d1 execute medilogy-poll-bot-db --file=./schema.sql
npm run dev
```

## Current status
The first scaffold provides webhook handling, `/start`, `/help`, `/settings`, `/send`, image-to-MCQ extraction, quiz poll creation, channel configuration and basic poll actions. This is a migration starter and must be tested in a private test chat before replacing the old bot. Telegram Bot API cannot edit an existing poll's question/options/correct answer in place; the bot must delete/recreate it, and it needs appropriate permissions in channels.

## Secrets
Set using:
```sh
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WEBHOOK_SECRET
```
Never commit `.dev.vars` or actual credentials.
