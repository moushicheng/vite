## websocket

创建 ws 服务

```typescript
const ws = createWebSocketServer(httpServer, config, httpsOptions)
```

接下来我们看看 websocket 的创建流程

1.使用用户自定义的 server 来创建 ws
以下步骤就是获取用户的 wsServer，然后 vite 将其打上 upgrade 事件

```typescript
function createWebSocketServer(server, config, httpsOptions) {
  //...
  const hmr = isObject(config.server.hmr) && config.server.hmr
  const hmrServer = hmr && hmr.server
  const hmrPort = hmr && hmr.port
  const wsServer = hmrServer || (portsAreCompatible && server)
  if (wsServer) {
    wss = new WebSocketServer({ noServer: true })
    //协议升级请求
    wsServer.on('upgrade', (req, socket, head) => {
      if (req.headers['sec-websocket-protocol'] === HMR_HEADER) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      }
    })
  } else {
    //...
  }
}
```

2. 如果用户没有自定义 server
   则处理选项然后创建 ws 服务

```javascript
    else {
    const websocketServerOptions: ServerOptions = {}
    const port = hmrPort || 24678
    const host = (hmr && hmr.host) || undefined
    if (httpsOptions) {
      // 如果我们通过https为中间件提供服务，ws库不支持自动创建https服务器，因此我们需要自己创建
      // 创建一个内联HTTPS服务器，并将websocket服务器挂载到它
      httpsServer = createHttpsServer(httpsOptions, (req, res) => {
        const statusCode = 426
        const body = STATUS_CODES[statusCode]
        if (!body)
          throw new Error(
            `No body text found for the ${statusCode} status code`
          )

        res.writeHead(statusCode, {
          'Content-Length': body.length,
          'Content-Type': 'text/plain'
        })
        res.end(body)
      })

      httpsServer.listen(port, host)
      websocketServerOptions.server = httpsServer
    } else {
      // we don't need to serve over https, just let ws handle its own server
      websocketServerOptions.port = port
      if (host) {
        websocketServerOptions.host = host
      }
    }
    // vite dev server in middleware mode
    wss = new WebSocketServerRaw(websocketServerOptions)
  }
```

### 事件机制

websocket 在创建完之后又在 message 中注册了 message 事件，它在 ws 接收消息的时候触发。
这里很明显用到的就是发布订阅模式

```typescript
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let parsed = JSON.parse(String(raw))
    //获取监听事件
    const listeners = customListeners.get(parsed.event)
    const client = getSocketClient(socket)
    listeners.forEach((listener) => listener(parsed.data, client))
  })
  socket.send(JSON.stringify({ type: 'connected' }))
  if (bufferedError) {
    socket.send(JSON.stringify(bufferedError))
  }
})
```

那么如何注册事件呢？这在最后 return 返回的对象给出了答案

#### 注册&注销

最后 createWebSocketServer 返回的对象中有 on , off send close 四个函数
先从注册注销说起

```typescript
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
}
```

#### 消息广播

消息发送:广播
即：向所有已经建立连接的客户端发送消息。

```typescript
return {
  //...
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
    if (payload.type === 'error' && !wss.clients.size) return

    //向所有已经建立连接的客户端发送消息（服务器广播）
    wss.clients.forEach((client) => {
      // 状态1意味着连接已经开放。
      if (client.readyState === 1) {
        client.send(JSON.stringify(payload))
      }
    })
  }
}
```
