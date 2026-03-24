# Cloudflare Pages Deploy

This repo is prepared for a Cloudflare Pages deployment where:

- `apps/web-public` is built as the static frontend
- `/api/public/*` is handled by Pages Functions in `functions/`
- the frontend talks to the API on the same origin

## Cloudflare Pages settings

- Build command: `npm ci && npm run build -w @fiapauto/web-public`
- Build output directory: `apps/web-public/dist`
- Root directory: `/`
- Functions directory: `functions`

## What the app expects

- The public frontend should run on the same domain as the API.
- `VITE_PUBLIC_API_BASE_URL` can stay unset in Cloudflare Pages because the frontend will call relative `/api/public/*` routes.
- `VITE_PUBLIC_AUTH_MODE` can stay unset. The frontend defaults to `none` outside local/private hosts.

## API behavior on Cloudflare

- `GET /api/public/manifest`
- `GET /api/public/topics`
- `GET /api/public/topics/:id`
- `GET /api/public/assets?key=...`
- `GET /api/public/sync/status`
- `POST /api/public/chat/topic`

Authentication endpoints are intentionally disabled in the first Cloudflare pass.
