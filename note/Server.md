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

首先是第一段解析配置

```javascript
//resolveConifg 地址：E:\work_space\Technology_related\Front-end\MVVM\vue\vite\vite-main\packages\vite\dist\node\chunks\dep-6b2ac8fa.js
const config = await resolveConfig(inlineConfig, 'serve', 'development')
```

1. 加载用户配置 vite.config.js
2. 初始化日志器
3. 加载插件

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

4. 解析根目录 [resolveRoot](https://cn.vitejs.dev/guide/#index-html-and-project-root)
5. 解析别名 resolvedAlias

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

6. 加载[env](https://cn.vitejs.dev/guide/env-and-mode.html#env-files)文件

```javascript
const envDir = config.envDir
  ? normalizePath(path.resolve(resolvedRoot, config.envDir))
  : resolvedRoot
const userEnv =
  inlineConfig.envFile !== false &&
  loadEnv(mode, envDir, resolveEnvPrefix(config))
```

7. 解析公共路径 url[base](https://cn.vitejs.dev/config/shared-options.html#base)

```javascript
const resolvedBase = relativeBaseShortcut
  ? !isBuild || config.build?.ssr
    ? '/'
    : './'
  : resolveBaseUrl(config.base, isBuild, logger) ?? '/'
```

8. 解析[构建选项](https://cn.vitejs.dev/config/build-options.html)

```javascript
const resolvedBuildOptions = resolveBuildOptions(config.build)
```

9. 解析[缓存文件夹](https://cn.vitejs.dev/config/shared-options.html#cachedir)

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

10. 解析内置钩子

其余还有很多解析，但都不太有紧要，所以略。
