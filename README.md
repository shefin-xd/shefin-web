# Shefin platform

This repository is organized as a small, centralized Shefin ecosystem: one API and one account session serve several independently deployed web applications.

## Domains and responsibilities

| Domain | Responsibility |
| --- | --- |
| `auth.shefin.dev` | The account sign-in experience and the only place users enter credentials. |
| `api.shefin.dev` | Central API and session authority. Routes are product namespaces: `/auth/*`, `/admin/*`, and `/chat/*`. |
| `admin.shefin.dev` | Admin frontend. It redirects to the account app when no session exists, then uses `/admin/*`. |
| `chat.shefin.dev` | Chat frontend. It redirects to the account app when no session exists, then uses `/chat/*`. |

The old `/messages/*` namespace remains as a compatibility alias during migration; new chat clients must use `/chat/*`.

## Sign-in journey (SSO-style)

1. A product app calls `GET https://api.shefin.dev/auth/check` with `credentials: "include"`.
2. If there is no session, it navigates to `https://auth.shefin.dev?returnTo=<current-app-url>`.
3. The Auth app signs in via `POST /auth/login`. The API issues the httpOnly `jwt` cookie.
4. Auth validates that `returnTo` is an HTTPS `*.shefin.dev` URL and redirects there. The product can now call its own API namespace.

No frontend reads or stores a JWT. This prevents browser JavaScript from accidentally exposing the session token.

## Local development

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

Serve each frontend directory with a static server. For local ports, set `window.SHEFIN_API_ORIGIN = "http://localhost:5001"` before loading `app.js`, and add those frontend origins to `CLIENT_URL`. Production must set `CLIENT_URL` to all deployed web origins, use HTTPS, and use a strong unique `JWT_SECRET`.

`COOKIE_DOMAIN` is intentionally optional. The secure default is a host-only cookie on `api.shefin.dev`; all apps authenticate by making credentialed requests to that central API. Set `COOKIE_DOMAIN=.shefin.dev` only after every current and future subdomain is trusted, because it broadens which hosts receive the session cookie.
