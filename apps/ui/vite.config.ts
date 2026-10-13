import { defineConfig, type Plugin } from 'vite'
import { contentSecurityPolicy } from './csp.ts'

const DEV_SERVER_PORT = 5173
const devServerUrl = `http://localhost:${DEV_SERVER_PORT}`

/** Injects the CSP meta tag: strict for builds, dev-server aware for vite serve. */
function cspMetaTag(isDev: boolean): Plugin {
  return {
    name: 'loam-csp',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: contentSecurityPolicy(isDev ? devServerUrl : undefined),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [cspMetaTag(command === 'serve')],
  server: {
    port: DEV_SERVER_PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}))
