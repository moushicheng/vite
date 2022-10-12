### 神奇的注入

一上来就看到了这一段，
**XXX\_**哪里来的？主要来源于：clientInjections.ts

```typescript
declare const __BASE__: string
declare const __SERVER_HOST__: string
declare const __HMR_PROTOCOL__: string | null
declare const __HMR_HOSTNAME__: string | null
declare const __HMR_PORT__: number | null
declare const __HMR_DIRECT_TARGET__: string
declare const __HMR_BASE__: string
declare const __HMR_TIMEOUT__: number
declare const __HMR_ENABLE_OVERLAY__: boolean

console.debug('[vite] connecting...')

const importMetaUrl = new URL(import.meta.url)

// use server configuration, then fallback to inference
const serverHost = __SERVER_HOST__
const socketProtocol =
  __HMR_PROTOCOL__ || (location.protocol === 'https:' ? 'wss' : 'ws')
const hmrPort = __HMR_PORT__
const socketHost = `${__HMR_HOSTNAME__ || importMetaUrl.hostname}:${
  hmrPort || importMetaUrl.port
}${__HMR_BASE__}`
const directSocketHost = __HMR_DIRECT_TARGET__
const base = __BASE__ || '/'
const messageBuffer: string[] = []
```

clientInjection,这个方式有点 hack

```typescript
return code
  .replace(`__MODE__`, JSON.stringify(config.mode))
  .replace(`__BASE__`, JSON.stringify(devBase))
  .replace(`__DEFINES__`, serializeDefine(config.define || {}))
  .replace(`__SERVER_HOST__`, JSON.stringify(serverHost))
  .replace(`__HMR_PROTOCOL__`, JSON.stringify(protocol))
  .replace(`__HMR_HOSTNAME__`, JSON.stringify(host))
  .replace(`__HMR_PORT__`, JSON.stringify(port))
  .replace(`__HMR_DIRECT_TARGET__`, JSON.stringify(directTarget))
  .replace(`__HMR_BASE__`, JSON.stringify(hmrBase))
  .replace(`__HMR_TIMEOUT__`, JSON.stringify(timeout))
  .replace(`__HMR_ENABLE_OVERLAY__`, JSON.stringify(overlay))
```
