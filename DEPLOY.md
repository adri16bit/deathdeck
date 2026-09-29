# DEATHDECK — deploy (Railway) + Spotify

Repo só do deck (sem o resto do js-lab).

## Local

```bash
npm install
npm start
# http://localhost:9756/DEATHDECK/
```

Opcional: `DEATHDECK/spotify.local.json` (veja o `.example`) e `gemini.local.json`.

## Railway

1. Conecta este repo no Railway (root = pasta do repo).
2. Variables: copie de `.env.example`.
3. Generate domain → ex. `https://seu-app.up.railway.app`
4. Spotify Dashboard → Redirect URI:
   ```
   https://seu-app.up.railway.app/api/deck/spotify/callback
   ```
5. Abra `https://seu-app.up.railway.app/DEATHDECK/` → `⋯` → conectar Spotify

Health: `/api/health`
