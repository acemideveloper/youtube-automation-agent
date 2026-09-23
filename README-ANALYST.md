# AgentTube Analyst Sidecar

Read-only YouTube channel intelligence that runs beside upstream AgentTube without initializing its production or publishing agents.

## Safety model

- Separate `analyst.js` entrypoint.
- Separate `config/analyst-tokens.json` OAuth token.
- OAuth scopes are limited to `youtube.readonly` and `yt-analytics.readonly` (optional monetary read-only scope).
- YouTube Data API client is wrapped by a runtime guard that blocks non-read methods.
- Dashboard binds to `127.0.0.1` by default; non-loopback binding requires `API_KEY`.
- Gemini is on-demand only; background analytics does not spend model quota.

## First run

1. `npm ci`
2. Configure the Google OAuth Desktop client using upstream setup so `config/credentials.json` exists.
3. `npm run analyst:auth`
4. Set `GEMINI_API_KEY` in `.env` if AI title/thumbnail advice is desired.
5. `npm run analyst:preflight`
6. `npm run test:analyst`
7. `npm run analyst`
8. Open `http://127.0.0.1:3456`.

The first catalog sync should be limited to 20–50 videos, then expanded after validation.
