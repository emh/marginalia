# Marginalia

A small reading-list app for saving articles, extracting metadata, and surfacing related reading.

## Local Development

Install dependencies:

```sh
npm install
```

Start the frontend and both local Workers:

```sh
npm run dev
```

The default local URLs are:

- Web app: `http://localhost:8010`
- Article Worker: `http://localhost:8787`
- Metadata Worker: `http://localhost:8788`

You can keep using WDS for the static app. Workers run separately through Wrangler so local behavior stays close to Cloudflare's runtime.

## Secrets

Do not put an OpenAI API key in localStorage or client-side code. Put it in the metadata Worker environment instead.

For local development, copy the examples:

```sh
cp workers/metadata/.dev.vars.example workers/metadata/.dev.vars
cp workers/article/.dev.vars.example workers/article/.dev.vars
```

For a first local run without OpenAI, leave `MOCK_LLM="true"` in `workers/metadata/.dev.vars`. The metadata Worker will return heuristic metadata and deterministic vectors.

When using OpenAI locally, set `OPENAI_API_KEY`, `OPENAI_MODEL`, and optionally `OPENAI_EMBEDDING_MODEL` in `workers/metadata/.dev.vars`, then set `MOCK_LLM="false"`.

For production, configure Cloudflare Worker secrets with Wrangler or the Cloudflare dashboard rather than committing them to the repository.

## Cloudflare Production

The frontend is static and can keep publishing to GitHub Pages. The frontend needs the public article Worker URL in `app/config.js`:

```js
globalThis.MARGINALIA_CONFIG = {
  apiBaseUrl: "https://marginalia-article.YOUR_WORKERS_SUBDOMAIN.workers.dev"
};
```

Keep the OpenAI key out of GitHub. Store it as a Cloudflare Worker secret on the metadata Worker:

```sh
npx wrangler secret put OPENAI_API_KEY --config workers/metadata/wrangler.toml
```

The production model names are non-secret Worker vars in `workers/metadata/wrangler.toml`. The GitHub Pages origin is allowed by CORS in `workers/article/wrangler.toml`; add any future custom frontend domain there too.

The Worker deploy workflow lives at `.github/workflows/deploy-workers.yml`. Add these GitHub repository secrets before relying on the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow deploys `marginalia-metadata` first, then `marginalia-article`, because the article Worker has a service binding to the metadata Worker.

You can also deploy manually:

```sh
npm run deploy:workers
```

## Current Shape

- `app/` contains the static GitHub Pages app.
- `workers/article/` is the public API Worker. It fetches article pages, extracts plain text, and asks the metadata Worker for metadata.
- `workers/metadata/` is the LLM-facing Worker. It is where the OpenAI key belongs.
- `prototype.html` remains as the original visual/interaction reference.
