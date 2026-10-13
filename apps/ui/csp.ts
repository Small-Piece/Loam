import { ASSET_SCHEME } from '@loam/protocol/bridge'

/**
 * Content Security Policy for the UI, injected into index.html as a meta tag. Production allows only the app's own
 * files. Development additionally allows the Vite dev server (scripts, HMR
 * socket) and inline styles, which Vite injects for CSS hot reload.
 */
export function contentSecurityPolicy(devServerUrl: string | undefined): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', `${ASSET_SCHEME}:`],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin
    const socket = origin.replace(/^http/, 'ws')
    directives['script-src']?.push(origin)
    directives['style-src']?.push(origin, "'unsafe-inline'")
    directives['connect-src']?.push(origin, socket)
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}
