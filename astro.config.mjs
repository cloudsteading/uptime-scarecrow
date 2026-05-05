import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  integrations: [],
  adapter: cloudflare({
    remoteBindings: false,
    platformProxy: { enabled: true },
    imageService: 'compile',
  }),
  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: ['**/.wrangler/**', '**/dist/**', '**/node_modules/**'],
      },
    },
  },
});
