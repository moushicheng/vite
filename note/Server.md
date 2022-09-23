# vite 后台服务构建流程

大致源码如下：↓

```javascript
async function createServer(inlineConfig = {}) {
  //解析配置，吐槽一下vite的配置选项真是多到超乎想象。。
  const config = await resolveConfig(inlineConfig, 'serve', 'development')
  const { root, server: serverConfig } = config
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  const { middlewareMode } = serverConfig
  const resolvedWatchOptions = resolveChokidarOptions({
    disableGlobbing: true,
    ...serverConfig.watch
  })
  // https://github.com/senchalabs/connect
  const middlewares = connect() //vite，server底层，一个connect中间层

  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
  const ws = createWebSocketServer(httpServer, config, httpsOptions)
  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }
  // ⚠️ 通过 chokidar 监控文件变化 hmr从这里开始
  // CHOKIDER介绍https://www.bilibili.com/read/cv5011048/
  const watcher = chokidar.watch(path.resolve(root), resolvedWatchOptions)

  // ⚠️ 初始化模块图
  const moduleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  )
  const container = await createPluginContainer(config, moduleGraph, watcher)
  const closeHttpServer = createServerCloseFn(httpServer)
  let exitProcess
  const server = {
    config,
    middlewares,
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    resolvedUrls: null,
    ssrTransform(code, inMap, url, originalCode = code) {
      return ssrTransform(code, inMap, url, originalCode, server.config)
    },
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null,
    async ssrLoadModule(url, opts) {
      if (isDepsOptimizerEnabled(config, true)) {
        await initDevSsrDepsOptimizer(config, server)
      }
      await updateCjsSsrExternals(server)
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace
      )
    },
    ssrFixStacktrace(e) {
      if (e.stack) {
        const stacktrace = ssrRewriteStacktrace(e.stack, moduleGraph)
        rebindErrorStacktrace(e, stacktrace)
      }
    },
    ssrRewriteStacktrace(stack) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    async listen(port, isRestart) {
      await startServer(server, port, isRestart)
      if (httpServer) {
        server.resolvedUrls = await resolveServerUrls(
          httpServer,
          config.server,
          config
        )
      }
      return server
    },
    async close() {
      if (!middlewareMode) {
        process.off('SIGTERM', exitProcess)
        if (process.env.CI !== 'true') {
          process.stdin.off('end', exitProcess)
        }
      }
      await Promise.all([
        watcher.close(),
        ws.close(),
        container.close(),
        closeHttpServer()
      ])
      server.resolvedUrls = null
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info
        )
      } else if (middlewareMode) {
        throw new Error('cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'cannot print server URLs before server.listen is called.'
        )
      }
    },
    async restart(forceOptimize) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },
    _ssrExternals: null,
    _restartPromise: null,
    _importGlobMap: new Map(),
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map()
  }
  server.transformIndexHtml = createDevHtmlTransformFn(server)
  if (!middlewareMode) {
    exitProcess = async () => {
      try {
        await server.close()
      } finally {
        process.exit()
      }
    }
    process.once('SIGTERM', exitProcess)
    if (process.env.CI !== 'true') {
      process.stdin.on('end', exitProcess)
    }
  }
  const { packageCache } = config
  const setPackageData = packageCache.set.bind(packageCache)
  packageCache.set = (id, pkg) => {
    if (id.endsWith('.json')) {
      watcher.add(id)
    }
    return setPackageData(id, pkg)
  }
  // hmr
  watcher.on('change', async (file) => {
    file = normalizePath(file)
    if (file.endsWith('/package.json')) {
      return invalidatePackageData(packageCache, file)
    }
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file)
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(file, server)
      } catch (err) {
        ws.send({
          type: 'error',
          err: prepareError(err)
        })
      }
    }
  })
  watcher.on('add', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })
  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })
  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = httpServer.address().port
    })
  }
  // apply server configuration hooks from plugins
  const postHooks = []
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook(server))
  }
  // Internal middlewares ------------------------------------------------------
  // request timer
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }
  // cors (enabled by default)
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }
  // proxy
  const { proxy } = serverConfig
  if (proxy) {
    middlewares.use(proxyMiddleware(httpServer, proxy, config))
  }
  // base
  const devBase = config.base
  if (devBase !== '/') {
    middlewares.use(baseMiddleware(server))
  }
  // open in editor support
  middlewares.use('/__open-in-editor', launchEditorMiddleware())
  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (config.publicDir) {
    middlewares.use(
      servePublicMiddleware(config.publicDir, config.server.headers)
    )
  }
  // main transform middleware
  middlewares.use(transformMiddleware(server))
  // serve static files
  middlewares.use(serveRawFsMiddleware(server))
  middlewares.use(serveStaticMiddleware(root, server))
  // spa fallback
  if (config.appType === 'spa') {
    middlewares.use(spaFallbackMiddleware(root))
  }
  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())
  if (config.appType === 'spa' || config.appType === 'mpa') {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(server))
    // handle 404s
    // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
    middlewares.use(function vite404Middleware(_, res) {
      res.statusCode = 404
      res.end()
    })
  }
  // error handler
  middlewares.use(errorMiddleware(server, middlewareMode))
  let initingServer
  let serverInited = false
  const initServer = async () => {
    if (serverInited) {
      return
    }
    if (initingServer) {
      return initingServer
    }
    initingServer = (async function () {
      await container.buildStart({})
      if (isDepsOptimizerEnabled(config, false)) {
        // non-ssr
        await initDepsOptimizer(config, server)
      }
      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }
  if (!middlewareMode && httpServer) {
    // overwrite listen to init optimizer before server start
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = async (port, ...args) => {
      try {
        await initServer()
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }
  } else {
    await initServer()
  }
  return server
}
```

## 解析配置

首先是第一段解析配置

```javascript
//resolveConifg 地址：E:\work_space\Technology_related\Front-end\MVVM\vue\vite\vite-main\packages\vite\dist\node\chunks\dep-6b2ac8fa.js
const config = await resolveConfig(inlineConfig, 'serve', 'development')
```

### 加载用户配置 vite.config.js

### 初始化日志器

### 加载插件

- workerPlugin
- userPlugin
  两种插件的过滤规则相同：

1. plugin.apply 不存在则返回 true
2. plugin.apply 存在， -是函数，则返回 apply()的结果 -否则比对，apply==command（command 默认 serve），
   所以可以推测 apply 是用来处理过滤规则的函数或字符串

```javascript
const rawUserPlugins = (await asyncFlatten(config.plugins || [])).filter(
  (p) => {
    if (!p) {
      return false
    } else if (p.apply == false) {
      return true
    } else if (typeof p.apply === 'function') {
      return p.apply({ ...config, mode }, configEnv)
    } else {
      return p.apply === command
    }
  }
)
```

然后会根据执行时机归类插件,并调用 config 钩子

```javascript
const [prePlugins, normalPlugins, postPlugins] = sortUserPlugins(rawUserPlugins)
// 执行config钩子，按orader= pre | normal | post 的顺序执行钩子
config = await runConfigHook(config, userPlugins, configEnv)
```

### 解析根目录 [resolveRoot](https://cn.vitejs.dev/guide/#index-html-and-project-root)

略

### 解析别名 resolvedAlias

```javascript
// resolve alias with internal client alias
const resolvedAlias = normalizeAlias(
  mergeAlias(
    // @ts-ignore because @rollup/plugin-alias' type doesn't allow function
    // replacement, but its implementation does work with function values.
    clientAlias,
    config.resolve?.alias || []
  )
)
const resolveOptions = {
  ...config.resolve,
  alias: resolvedAlias
}
```

### 加载[env](https://cn.vitejs.dev/guide/env-and-mode.html#env-files)文件

```javascript
//获取envDir路径
const envDir = config.envDir
  ? normalizePath(path.resolve(resolvedRoot, config.envDir))
  : resolvedRoot
//根据envDir加载env文件
const userEnv =
  inlineConfig.envFile !== false &&
  loadEnv(mode, envDir, resolveEnvPrefix(config))
```

最后 env 会随着 config.env 返回,基本上这里就是一些环境配置，在应用中我们根据 import.meta.env 来获取

```javascript
config.env = {
  ...userEnv,
  BASE_URL,
  MODE: mode,
  DEV: !isProduction,
  PROD: isProduction
}
```

### 解析公共路径 url[base](https://cn.vitejs.dev/config/shared-options.html#base)

```javascript
const resolvedBase = relativeBaseShortcut
  ? !isBuild || config.build?.ssr
    ? '/'
    : './'
  : resolveBaseUrl(config.base, isBuild, logger) ?? '/'
```

### 解析[构建选项](https://cn.vitejs.dev/config/build-options.html)

```javascript
const resolvedBuildOptions = resolveBuildOptions(config.build)
```

### 解析[缓存文件夹](https://cn.vitejs.dev/config/shared-options.html#cachedir)

```javascript
// resolve cache directory
const pkgPath = lookupFile(resolvedRoot, [`package.json`], { pathOnly: true })
const cacheDir = config.cacheDir
  ? path.resolve(resolvedRoot, config.cacheDir)
  : pkgPath
  ? path.join(path.dirname(pkgPath), `node_modules/.vite`)
  : path.join(resolvedRoot, `.vite`)
const assetsFilter = config.assetsInclude
  ? createFilter(config.assetsInclude)
  : () => false
```

### 解析内置钩子

其余还有很多解析，但都不太有紧要，所以略。

## 创建服务

### http

这里似乎是有创建的动作，因此 http 的执行细节还没有体现

```typescript
const { root, server: serverConfig } = config
//解析https
const httpsOptions = await resolveHttpsConfig(
  config.server.https,
  config.cacheDir
)
const { middlewareMode } = serverConfig

const resolvedWatchOptions = resolveChokidarOptions({
  disableGlobbing: true,
  ...serverConfig.watch
})

const middlewares = connect() as Connect.Server //vite，server底层，一个connect中间层,可以通过http.createServer(connect())来创建
//相当于http.createServer(middlewares)
//暂时不知道httpServer的共用，我猜是给客户端import的时候按需上传文件
const httpServer = middlewareMode
  ? null
  : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
```

### ws

创建 ws 服务

```javascript
const ws = createWebSocketServer(httpServer, config, httpsOptions)
```

接下来我们看看 websocket 的创建流程，因为这可能和 hmr 有关

```javascript
function createWebSocketServer(server, config, httpsOptions) {
  let wss
  let httpsServer = undefined
  const hmr = isObject(config.server.hmr) && config.server.hmr
  const hmrServer = hmr && hmr.server
  const hmrPort = hmr && hmr.port
  // TODO: the main server port may not have been chosen yet as it may use the next available
  const portsAreCompatible = !hmrPort || hmrPort === config.server.port
  const wsServer = hmrServer || (portsAreCompatible && server)
  const customListeners = new Map()
  const clientsMap = new WeakMap()

  // ⚠️ 只处理带HMR_HEADER的协议升级请求
  if (wsServer) {
    wss = new WebSocketServer({ noServer: true })
    //接管ws协议升级事件，只接受HMR的升级请求
    wsServer.on('upgrade', (req, socket, head) => {
      if (req.headers['sec-websocket-protocol'] === HMR_HEADER) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      }
    })
  }
  //...
}
```

#### 事件机制

注意看 socket 的 Event.message,其中 customListeners 就是记录事件的 Map

```javascript
wss.on('connection', (socket) => {
  console.log('@connection')
  socket.on('message', (raw) => {
    console.log('@message')
    if (!customListeners.size) return
    let parsed
    try {
      parsed = JSON.parse(String(raw))
    } catch {}
    console.log(parsed)
    if (!parsed || parsed.type !== 'custom' || !parsed.event) return
    const listeners = customListeners.get(parsed.event)
    if (!listeners?.size) return
    const client = getSocketClient(socket)
    listeners.forEach((listener) => listener(parsed.data, client))
  })
  socket.send(JSON.stringify({ type: 'connected' }))
  if (bufferedError) {
    socket.send(JSON.stringify(bufferedError))
    bufferedError = null
  }
})
```

##### 触发

```javascript
const listeners = customListeners.get(parsed.event)
listeners.forEach((listener) => listener(parsed.data, client))
```

##### 注册&注销

最后 createWebSocketServer 返回的对象中有 on 和 off 两个函数

```javascript
return {
  on: (event, fn) => {
    if (wsServerEvents.includes(event)) wss.on(event, fn)
    else {
      if (!customListeners.has(event)) {
        customListeners.set(event, new Set())
      }
      customListeners.get(event).add(fn)
    }
  },
  off: (event, fn) => {
    if (wsServerEvents.includes(event)) {
      wss.off(event, fn)
    } else {
      customListeners.get(event)?.delete(fn)
    }
  }
  //...
}
```

消息发送:服务器广播的形式

```javascript
return {
  send(...args) {
    let payload
    if (typeof args[0] === 'string') {
      payload = {
        type: 'custom',
        event: args[0],
        data: args[1]
      }
    } else {
      payload = args[0]
    }
    if (payload.type === 'error' && !wss.clients.size) {
      bufferedError = payload
      return
    }
    const stringified = JSON.stringify(payload)
    //向所有已经建立连接的客户端发送消息（服务器广播）
    wss.clients.forEach((client) => {
      // readyState 1 means the connection is open
      if (client.readyState === 1) {
        client.send(stringified)
      }
    })
  }
}
```

#### 注册错误事件

```javascript
//in createServer
if (httpServer) {
  setClientErrorHandler(httpServer, config.logger)
}
```

具体逻辑也很简单,用到了我们上面提到的事件注册

```typescript
export function setClientErrorHandler(
  server: HttpServer,
  logger: Logger
): void {
  server.on('clientError', (err, socket) => {
    let msg = '400 Bad Request'
    if ((err as any).code === 'HPE_HEADER_OVERFLOW') {
      msg = '431 Request Header Fields Too Large'
      logger.warn(
        colors.yellow(
          'Server responded with status code 431. ' +
            'See https://vitejs.dev/guide/troubleshooting.html#_431-request-header-fields-too-large.'
        )
      )
    }
    if ((err as any).code === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end(`HTTP/1.1 ${msg}\r\n\r\n`)
  })
}
```

## 文件监控

chokidar 用于文件监控，关于 chokidar 可以看[这里](https://github.com/paulmillr/chokidar)

```javascript
  const watcher = chokidar.watch(
    path.resolve(root),
    resolvedWatchOptions
  ) as FSWatcher
```

### 监控事件

```javascript
watcher.on('change', async (file) => {
  console.log('@change')
  //...
})
watcher.on('add', (file) => {
  console.log('@add')
  //...
})
watcher.on('unlink', (file) => {
  console.log('@unlink')
  //...
})
```

我们对如上三个事件打上 console.log
经验证，在你改变项目文件时，添加，删除时都会如实触发，读者也可以试试。

#### change 【hmr 核心】

```javascript
watcher.on('change', async (file) => {
  //获取文件路径
  file = normalizePath(file)
  //不处理package.json的文件改动
  if (file.endsWith('/package.json')) {
    return invalidatePackageData(packageCache, file)
  }
  // invalidate module graph cache on file change
  // 在文件更改时，使依赖图缓存失效
  moduleGraph.onFileChange(file)
  if (serverConfig.hmr !== false) {
    try {
      //尝试热更新
      await handleHMRUpdate(file, server)
    } catch (err) {
      ws.send({
        type: 'error',
        err: prepareError(err)
      })
    }
  }
})
```

上面几个点，比较细致的 moduleGraph 先不谈
我们看看 handleHMRUpdate
