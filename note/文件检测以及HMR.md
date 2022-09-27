## 文件监控

chokidar 用于文件监控，关于 chokidar 可以看[这里](https://github.com/paulmillr/chokidar)

```typescript
const watcher = chokidar.watch(
  path.resolve(root),
  resolvedWatchOptions
) as FSWatcher
```

### 监控事件

```typescript
watcher.on('change', async (file) => {
  //...
})
watcher.on('add', (file) => {
  handleFileAddUnlink(normalizePath(file), server)
})
watcher.on('unlink', (file) => {
  handleFileAddUnlink(normalizePath(file), server)
})
```

我们对如上三个事件打上 console.log
经验证，在你改变项目文件时，添加，删除时都会如实触发，读者也可以试试。

#### change 【hmr 核心】

```typescript
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

### handleHMRUpdate

```typescript
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const { ws, config, moduleGraph } = server
  const shortFile = getShortName(file, config.root)
  const fileName = path.basename(file)

  const isConfig = file === config.configFile
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name
  )
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.'))

  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    debugHmr(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${path.relative(process.cwd(), file)} changed, restarting server...`
      ),
      { clear: true, timestamp: true }
    )
    try {
      await server.restart()
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr(`[file change] ${colors.dim(shortFile)}`)

  // (dev only) the client itself cannot be hot updated.
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: 'full-reload',
      path: '*'
    })
    return
  }

  const mods = moduleGraph.getModulesByFile(file)

  // check if any plugin wants to perform custom HMR handling
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file),
    server
  }

  for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
    const filteredModules = await hook(hmrContext)
    if (filteredModules) {
      hmrContext.modules = filteredModules
    }
  }

  if (!hmrContext.modules.length) {
    // html file cannot be hot updated
    if (file.endsWith('.html')) {
      config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
        clear: true,
        timestamp: true
      })
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + normalizePath(path.relative(config.root, file))
      })
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr(`[no modules matched] ${colors.dim(shortFile)}`)
    }
    return
  }

  updateModules(shortFile, hmrContext.modules, timestamp, server)
}
```

在 env/config 文件变动时重启整个服务器

```typescript
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<void> {
  const { ws, config, moduleGraph } = server
  const shortFile = getShortName(file, config.root)
  const fileName = path.basename(file)

  const isConfig = file === config.configFile //判断修改文件是不是config
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name
  ) //判断修改文件是不是ConfigDependency
  const isEnv =
    config.inlineConfig.envFile !== false &&
    (fileName === '.env' || fileName.startsWith('.env.')) //判断环境文件

  if (isConfig || isConfigDependency || isEnv) {
    // auto restart server
    await server.restart()
    return
  }
  //....
```

如果修改项是 client 内的文件，则不需要热更新,而是全量更新

```javascript
//....
if (file.startsWith(normalizedClientDir)) {
  ws.send({
    type: 'full-reload',
    path: '*'
  })
  return
}
```

我们可以发现载荷是{type:'full-reload',path:'\*'}，我们先按下不表，只需要知道它是通知客户端 ws 进行全量更新即可
然后执行 handleHotUpdate 钩子,可以看到 vite 对于 handleHotUpdate 钩子的期待似乎只是做过滤模块。

```javascript
for (const hook of config.getSortedPluginHooks('handleHotUpdate')) {
  const filteredModules = await hook(hmrContext)
  if (filteredModules) {
    hmrContext.modules = filteredModules
  }
}
```

然后对 html 若发生异动，则全量更新

```javascript
if (!hmrContext.modules.length) {
  // html file cannot be hot updated
  if (file.endsWith('.html')) {
    config.logger.info(colors.green(`page reload `) + colors.dim(shortFile), {
      clear: true,
      timestamp: true
    })
    ws.send({
      type: 'full-reload',
      path: config.server.middlewareMode
        ? '*'
        : '/' + normalizePath(path.relative(config.root, file))
    })
  } else {
    // loaded but not in the module graph, probably not js
    debugHmr(`[no modules matched] ${colors.dim(shortFile)}`)
  }
  return
}
```

兜兜转转，最后终于到了实际上的热更新

```javascript
updateModules(shortFile, hmrContext.modules, timestamp, server)
```

### updateModules

```typescript
function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws }: ViteDevServer
): void {
  const updates: Update[] = []
  const invalidatedModules = new Set<ModuleNode>()
  let needFullReload = false

  for (const mod of modules) {
    invalidate(mod, timestamp, invalidatedModules)
    if (needFullReload) {
      continue
    }

    const boundaries = new Set<{
      boundary: ModuleNode
      acceptedVia: ModuleNode
    }>()
    const hasDeadEnd = propagateUpdate(mod, boundaries)
    if (hasDeadEnd) {
      needFullReload = true
      continue
    }

    updates.push(
      ...[...boundaries].map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as const,
        timestamp,
        path: boundary.url,
        explicitImportRequired:
          boundary.type === 'js'
            ? isExplicitImportRequired(acceptedVia.url)
            : undefined,
        acceptedPath: acceptedVia.url
      }))
    )
  }

  if (needFullReload) {
    config.logger.info(colors.green(`page reload `) + colors.dim(file), {
      clear: true,
      timestamp: true
    })
    ws.send({
      type: 'full-reload'
    })
    return
  }

  if (updates.length === 0) {
    debugHmr(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  config.logger.info(
    updates
      .map(({ path }) => colors.green(`hmr update `) + colors.dim(path))
      .join('\n'),
    { clear: true, timestamp: true }
  )
  ws.send({
    type: 'update',
    updates
  })
}
```

在 Vite 中，HMR 是在原生 ESM 上执行的。当编辑一个文件时，Vite 只需要精确地使已编辑的模块与其最近的 HMR 边界之间的链失活（大多数时候只是模块本身），使得无论应用大小如何，HMR 始终能保持快速更新。

```typescript
for (const mod of modules) {
  //失活操作
  invalidate(mod, timestamp, invalidatedModules)
  if (needFullReload) {
    continue
  }

  const boundaries = new Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>()
  const hasDeadEnd = propagateUpdate(mod, boundaries)
  if (hasDeadEnd) {
    needFullReload = true
    continue
  }

  updates.push(
    ...[...boundaries].map(({ boundary, acceptedVia }) => ({
      type: `${boundary.type}-update` as const,
      timestamp,
      path: boundary.url,
      explicitImportRequired:
        boundary.type === 'js'
          ? isExplicitImportRequired(acceptedVia.url)
          : undefined,
      acceptedPath: acceptedVia.url
    }))
  )
}
```
