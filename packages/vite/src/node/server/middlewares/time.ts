import { performance } from 'node:perf_hooks'
import type { Connect } from 'types/connect'
import { createDebugger, prettifyUrl, timeFrom } from '../../utils'

const logTime = createDebugger('vite:time')

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
