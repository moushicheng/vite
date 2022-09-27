## 简单介绍

vite 会在创建服务器（createServer）时，创建 http 服务和 ws 服务，我们这里仅仅先介绍 http 服务
http 服务提供这些功能

1. 记录服务时间
2. 提供 cors 能力（如果用户配置了 cors 选项
3. 代理能力
4. 解析 base，提供合适的文件路径
5. vue devtools \_\_open-in-editor 能力支持
6. 解析静态资源文件夹
7. 处理资源请求，并执行 resolve, load and transform
8. ...
9. ...

## 创建

### http

http 服务的底层是[connect](https://github.com/senchalabs/connect)

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
//相当于http.createServer(middlewares)，把服务打开。
//暂时不知道httpServer的共用，我猜是给客户端import的时候按需上传文件
const httpServer = middlewareMode
  ? null
  : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
```

### 配合 http 服务的中间件们

大致看一下就好，根据名字，这其实就对应我开头说的 http 能力

```javascript
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
if (config.publicDir) {
  middlewares.use(
    servePublicMiddleware(config.publicDir, config.server.headers)
  )
}

// main transform middleware
middlewares.use(transformMiddleware(server))
//...其余中间件省略
```

所以，我们挑一个最简单的中间件看一下结构吧

```typescript
export function timeMiddleware(root: string): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteTimeMiddleware(req, res, next) {
    //洋葱模型，最先记录，最后输出
    const start = performance.now()
    const end = res.end
    res.end = (...args: any[]) => {
      logTime(`${timeFrom(start)} ${prettifyUrl(req.url!, root)}`)
      // @ts-ignore
      return end.call(res, ...args)
    }
    next()
  }
}
```

这里是洋葱模型的结构，在这里，先执行的中间件的 end 函数反而会最后执行。
如果读者还不太清楚，可以看看这个 demo

```typescript
const connect = require('connect')
var app = connect()
const port = 3000

var server = app.listen(port)

app.use(function (req, res, next) {
  // i had an error
  console.log('@1')
  const end = res.end
  res.end = (...args) => {
    console.log('@end 1;')
    return end.call(res, ...args)
  }

  next()
})

app.use(function (req, res, next) {
  console.log('@2')

  const end = res.end
  res.end = (...args) => {
    console.log('@end 2;')
    return end.call(res, ...args)
  }
  next()
})
app.use(function (req, res, next) {
  res.end()
})
console.log('server start in http://localhost:3000')
```

最后的输出结果是

```
server start in http://localhost:3000
@1
@2
@end 2;
@end 1;
```

### vite 如何处理资源请求？

答案是在 transformMiddleware 这个中间件

```javascript
middlewares.use(transformMiddleware(server))
```

其核心关键代码贴出来了，就是 transformRequest，其中会创建模块，然后依次执行插件钩子（resolveId，load，transform）对源码完成最终的生成，然后再发送给浏览器前端

```typescript
function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  //...
  // resolve, load and transform using the plugin container
  const result = await transformRequest(url, server, {
    html: req.headers.accept?.includes('text/html')
  })
  if (result) {
    const depsOptimizer = getDepsOptimizer(server.config, false) // non-ssr
    const type = isDirectCSSRequest(url) ? 'css' : 'js'
    const isDep =
      DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)
    return send(req, res, result.code, type, {
      etag: result.etag,
      // allow browser to cache npm deps!
      cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
      headers: server.config.server.headers,
      map: result.map
    })
  }
}
//...
```

现在看看 transformRequest，这一层是对核心在做了一层缓存的包装
如果当前的请求是在缓存内，就不执行 doTransform 处理模块了，否则，就走一遍 doTransform 流程
在请求结束后，会再从缓存中清理请求，防止请求一直存活。

```javascript
function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  const timestamp = Date.now()

  //缓存处理,防止重复请求时的重复loading资源
  const pending = server._pendingRequests.get(cacheKey)
  if (pending) {
    return server.moduleGraph
      .getModuleByUrl(removeTimestampQuery(url), options.ssr)
      .then((module) => {
        if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
          return pending.request
        } else {
          pending.abort()
          return transformRequest(url, server, options)
        }
      })
  }
  //核心逻辑
  const request = doTransform(url, server, options, timestamp)

  // 在请求结束时清理缓存
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      server._pendingRequests.delete(cacheKey)
      cleared = true
    }
  }
  //设置缓存
  server._pendingRequests.set(cacheKey, {
    request,
    timestamp,
    abort: clearCache
  })
  request.then(clearCache, clearCache)

  return request
}
```

再看看 doTransform，这里会先执行 resolveId，再处理 load 和 transform

```typescript
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  url = removeTimestampQuery(url)

  const { config, pluginContainer } = server
  const prettyUrl = isDebug ? prettifyUrl(url, config.root) : ''
  const ssr = !!options.ssr

  //获取是否有已经缓存了的模块
  const module = await server.moduleGraph.getModuleByUrl(url, ssr)

  // check if we have a fresh cache
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    isDebug && debugCache(`[memory] ${prettyUrl}`)
    return cached
  }

  // resolve，执行resolve核心逻辑
  const id =
    (await pluginContainer.resolveId(url, undefined, { ssr }))?.id || url

  //执行load和transform
  const result = loadAndTransform(id, url, server, options, timestamp)

  getDepsOptimizer(config, ssr)?.delayDepsOptimizerUntil(id, () => result)

  return result
}
```

loadAndTransform
先贴出源码，读者先大致浏览一遍，我会在下面一一拆解。

```typescript
async function loadAndTransform(
  id: string,
  url: string,
  server: ViteDevServer,
  options: TransformOptions,
  timestamp: number
) {
  //执行load hook
  const loadResult = await pluginContainer.load(id, { ssr })
  if (loadResult == null) {
    // if this is an html request and there is no load result, skip ahead to
    // SPA fallback.
    //如果是html文件，就交给spa fallback中间件调用
    if (options.html && !id.endsWith('.html')) {
      return null
    }
    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users
    if (options.ssr || isFileServingAllowed(file, server)) {
      try {
        code = await fs.readFile(file, 'utf-8')
        isDebug && debugLoad(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e
        }
      }
    }
    if (code) {
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          convertSourceMap.fromMapFileSource(code, path.dirname(file))
        )?.toObject()
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true
        })
      }
    }
  } else {
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }
  if (code == null) {
    if (checkPublicFile(url, config)) {
      throw new Error(
        `Failed to load url ${url} (resolved id: ${id}). ` +
          `This file is in /public and will be copied as-is during build without ` +
          `going through the plugin transforms, and therefore should not be ` +
          `imported from source code. It can only be referenced via HTML tags.`
      )
    } else {
      return null
    }
  }

  // ensure module in graph after successful load
  const mod = await moduleGraph.ensureEntryFromUrl(url, ssr)
  ensureWatchedFile(watcher, mod.file, root)

  // transform
  const transformStart = isDebug ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr
  })
  const originalCode = code
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // no transform applied, keep code as-is
    isDebug &&
      debugTransform(
        timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`)
      )
  } else {
    isDebug && debugTransform(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  if (map && mod.file) {
    map = (typeof map === 'string' ? JSON.parse(map) : map) as SourceMap
    if (map.mappings && !map.sourcesContent) {
      await injectSourcesContent(map, mod.file, logger)
    }
  }

  const result = ssr
    ? await server.ssrTransform(code, map as SourceMap, url, originalCode)
    : ({
        code,
        map,
        etag: getEtag(code, { weak: true })
      } as TransformResult)

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp) {
    if (ssr) mod.ssrTransformResult = result
    else mod.transformResult = result
  }

  return result
}
```

首先，执行 load hook

```javascript
const loadResult = await pluginContainer.load(id, { ssr })
```

如果 loadResult 为空,则尝试加载源码文件，并分析获得其 Sourcemap

```javascript
if (loadResult == null) {
  if (options.ssr || isFileServingAllowed(file, server)) {
    code = await fs.readFile(file, 'utf-8') //加载源码文件
  }
}
if (code) {
  map = (
    convertSourceMap.fromSource(code) ||
    convertSourceMap.fromMapFileSource(code, path.dirname(file))
  )?.toObject()
}
```

如果 loadResult 不为空，则直接赋值 code 和 map，用于最终的 return

```typescript
else {
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
}
```

在 load 执行完毕后

```typescript
// ensure module in graph after successful load
//创建模块
const mod = await moduleGraph.ensureEntryFromUrl(url, ssr)
ensureWatchedFile(watcher, mod.file, root)
```

mod 最终长这样

```javascript
{
  id: "E:/work_space/Technology_related/Front-end/MVVM/vue/vite/vite-main/playground/cli/index.js",
  file: "E:/work_space/Technology_related/Front-end/MVVM/vue/vite/vite-main/playground/cli/index.js",
  importers: {
  },
  importedModules: {
  },
  acceptedHmrDeps: {
  },
  acceptedHmrExports: null,
  importedBindings: null,
  transformResult: null,
  ssrTransformResult: null,
  ssrModule: null,
  ssrError: null,
  lastHMRTimestamp: 0,
  lastInvalidationTimestamp: 0,
  url: "/index.js",
  type: "js",
  isSelfAccepting: false,
}
```

ensureWatchedFile(watcher, mod.file, root)很简单
监控根目录外的文件变动，暂时还不知道有什么用，为什么要监视根目录文件外的文件？

```javascript
if (
  file &&
  // only need to watch if out of root
  !file.startsWith(root + '/') &&
  // some rollup plugins use null bytes for private resolved Ids
  !file.includes('\0') &&
  fs.existsSync(file)
) {
  // resolve file to normalized system path
  watcher.add(path.resolve(file))
}
```

然后，走一遍 transform 流程

```javascript
const transformResult = await pluginContainer.transform(code, id, {
  inMap: map,
  ssr
})
```

后续，对 result 做一些后处理，如果返回的 result 不对劲（某些参数丢失或者 result 本身就是 null 的情况下），就 debug 记录一下
最终返回 result
