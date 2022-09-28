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

如果修改的是 vite 自带的 client 脚本，就刷新页面；

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
    ws.send({
      type: 'full-reload'
    })
    return
  }

  if (updates.length === 0) {
    return
  }
  ws.send({
    type: 'update',
    updates
  })
}
```

在 Vite 中，HMR 是在原生 ESM 上执行的。当编辑一个文件时，Vite 只需要精确地使已编辑的模块与其最近的 HMR 边界之间的链失活（大多数时候只是模块本身），使得无论应用大小如何，HMR 始终能保持快速更新。

invalidate 的语义是失活
怎么理解？ 即更新当前模块的热更新时间，并将其转换结果都清除。
PS : 为什么要这么做？ 现在还不是很理解..

```typescript
for (const mod of modules) {
  //失活操作
  invalidate(mod, timestamp, invalidatedModules)
  if (needFullReload) {
    continue
  }
}
```

即进行设置如下，

```javascript
mod.lastHMRTimestamp = timestamp
mod.transformResult = null
mod.ssrModule = null
mod.ssrError = null
mod.ssrTransformResult = nul
mod.importers.forEach((importer) => {
  //如果importer没有[接受]mod，就让importer失活
  if (!importer.acceptedHmrDeps.has(mod)) {
    invalidate(importer, timestamp, seen)
  }
})
```

失活后就会执行 propagateUpdate

### propagateUpdate

它通常用于构建 边缘链（即分析出最终需要热更新处理的模块
他有如下行为

1. 对于自接受模块（isSelfAccepting==true）则直接加入边缘链
2. 寻找 deadEnd（即循环引用，寻找的过程后续会讲）
   - 如果发现，则返回 true，后续会因为 hasDeadEnd==true，而直接导致应用全量更新
   - 如果没有，则返回 false，后续会因为 hasDeadEnd==false，应用按需更新。

解释：

1. 什么是 isSelfAccept？
   importAnalysis 插件会在 transform 分析应用 import.meta.hot.accept(() => {})或者 import.meta.hot.accept()的模块
   这俩是[HMR API](https://cn.vitejs.dev/guide/api-hmr.html#hot-acceptcb)
   如此，模块会被打上 isSelfAccepting=true 的标志

```javascript
function propagateUpdate(
  node: ModuleNode,
  boundaries: Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>,
  currentChain: ModuleNode[] = [node]
): boolean /* hasDeadEnd */ {
  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    return false
  }

  if (node.isSelfAccepting) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })

    // additionally check for CSS importers, since a PostCSS plugin like
    // Tailwind JIT may register any file as a dependency to a CSS file.
    for (const importer of node.importers) {
      if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
        propagateUpdate(importer, boundaries, currentChain.concat(importer))
      }
    }

    return false
  }
  // A -> B(B.importers=[A,...])
  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,(B必须在A之前更新)
  // so that they do get the fresh imported module when/if they are reloaded. （以便A更新时，B是最新的）
  if (node.acceptedHmrExports) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })
  } else {
    if (!node.importers.size) {
      return true
    }

    // #3716, #3913
    // For a non-CSS file, if all of its importers are CSS files (registered via
    // PostCSS plugins) it should be considered a dead end and force full reload.
    if (
      !isCSSRequest(node.url) &&
      [...node.importers].every((i) => isCSSRequest(i.url))
    ) {
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.add({
        boundary: importer,
        acceptedVia: node
      })
      continue
    }

    if (node.id && node.acceptedHmrExports && importer.importedBindings) {
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (currentChain.includes(importer)) {
      // circular deps is considered dead end
      return true
    }

    if (propagateUpdate(importer, boundaries, subChain)) {
      return true
    }
  }
  return false
}
```

加入边缘链满足以下条件即可：
一：对于自更新模块,直接加入边缘链，然后返回 false

```typescript
if (node.isSelfAccepting) {
  boundaries.add({
    boundary: node,
    acceptedVia: node
  })

  //先跳过分析
  // additionally check for CSS importers, since a PostCSS plugin like
  // Tailwind JIT may register any file as a dependency to a CSS file.
  for (const importer of node.importers) {
    if (isCSSRequest(importer.url) && !currentChain.includes(importer)) {
      propagateUpdate(importer, boundaries, currentChain.concat(importer))
    }
  }

  return false
}
```

条件二：如果当前模块被其他模块接收了，也需要加入边缘链
举例:A 导入了 B
A 中书写代码

```typescript
import.meta.hot.accept('./b.js', (modB) => {
  console.log(modB)
})
```

那么 B.acceptedHmrExports 就会为 true

```typescript
// A -> B(B.importers=[A,...])
// A partially accepted module with no importers is considered self accepting,
// because the deal is "there are parts of myself I can't self accept if they
// are used outside of me".
// Also, the imported module (this one) must be updated before the importers,(B必须在A之前更新)
// so that they do get the fresh imported module when/if they are reloaded. （以便A更新时，B是最新的）
if (node.acceptedHmrExports) {
  boundaries.add({
    boundary: node,
    acceptedVia: node
  })
} else {
  //...边界情况，暂时不考虑
}
```

然后，就开始解析 importer

```javascript
for (const importer of node.importers) {
  const subChain = currentChain.concat(importer)
  //importer.acceptedHmrDeps 获取到的是模块中 import.meta.hot.accept 的 dep(s) 参数
  if (importer.acceptedHmrDeps.has(node)) {
    //如果导入者 接受了当年模块则将其加入边界
    boundaries.add({
      boundary: importer,
      acceptedVia: node
    })
    continue
  }

  if (node.id && node.acceptedHmrExports && importer.importedBindings) {
    const importedBindingsFromNode = importer.importedBindings.get(node.id)
    if (
      importedBindingsFromNode &&
      areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
    ) {
      continue
    }
  }

  // 有循环引用，直接全量更新
  if (currentChain.includes(importer)) {
    // circular deps is considered dead end
    return true
  }

  //递归
  if (propagateUpdate(importer, boundaries, subChain)) {
    return true
  }
}
```

最后借用[小余](https://juejin.cn/user/3210229686216222)的一张流程图 ↓

![img](https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/a67dbbef49b4471a855b490100ab606a~tplv-k3u1fbpfcp-zoom-in-crop-mark:3024:0:0:0.awebp)
