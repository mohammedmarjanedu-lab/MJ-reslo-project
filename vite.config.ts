import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  resolve: {
    alias: { $lib: '/src/lib' },
  },
  optimizeDeps: {
    include: ['p5'],
  },
  worker: {
    format: 'es',
  },
})

