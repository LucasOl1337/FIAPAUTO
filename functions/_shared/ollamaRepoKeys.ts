export type OllamaRepoKey = {
  name: string
  value: string
}

// Synced from frontend/keys.py for Cloudflare Pages server-side requests.
export const OLLAMA_REPO_KEYS: OllamaRepoKey[] = [
  {
    name: 'Kroco',
    value: '04fb9ba4da6f4725acd285285d487d45.Az7I4Zq2Xv0zXkVJ6BJVsZbb',
  },
  {
    name: 'Kled',
    value: '20a4f67f87b949e6ae51b56c575614f5.LKmv3kQAJLc4lVvqvRpCLIKk',
  },
  {
    name: 'Unkro',
    value: '8ac959e485ef4be293ae0a3f73669aee.S_koGMxakJuO6ioSXZeLQo3e',
  },
  {
    name: 'lol',
    value: '82a0d0550d814a249793098e86926bdc.vyBYFgHrZZ5svMdV6nXTRpxd',
  },
]
