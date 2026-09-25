# Shefin Auth frontend

Deploy at `auth.shefin.dev`. This is the central sign-in page: it checks the session at the API, signs in through `POST /api/auth/login`, validates the requested `returnTo` destination, and returns the user to a Shefin app.

The page imports `../shared/auth-client.js`; package or copy the shared directory with this application during independent deployments.
