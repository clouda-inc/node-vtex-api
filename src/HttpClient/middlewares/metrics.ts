import { compose, forEach, path, reduce, replace, split } from 'ramda'

import { MetricsAccumulator } from '../../metrics/MetricsAccumulator'
import { hrToMillis, shrinkTimings } from '../../utils'
import { TIMEOUT_CODE } from '../../utils/retry'
import { statusLabel } from '../../utils/status'
import { MiddlewareContext } from '../typings'

const parseServerTiming = (serverTimingsHeaderValue: string) => compose<string, string, string[], Array<[string, string]>>(
  reduce((acc, rawHeader) => {
    const [hopAndName, durStr] = rawHeader.split(';')
    const [hop, name]  = hopAndName ? hopAndName.split('%') : [null, null]
    const [_, dur] = durStr ? durStr.split('=') : [null, null]
    const incrementedName = !hop || Number.isNaN(hop as any) ? name : `${Number(hop)+1}%${name}`
    if (dur && incrementedName) {
      acc.push([incrementedName, dur])
    }
    return acc
  }, [] as Array<[string, string]>),
  split(','),
  replace(/\s/g, '')
)(serverTimingsHeaderValue)

interface MetricsOpts {
  metrics?: MetricsAccumulator
  serverTiming?: Record<string, string>
  name?: string
}

export const metricsMiddleware = ({metrics, serverTiming, name}: MetricsOpts) => {
  const serverTimingLabel = shrinkTimings(`0%${process.env.VTEX_APP_NAME}#${name || 'unknown'}`)
  const serverTimingStart = process.hrtime()
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const start = process.hrtime()
    let status: string = 'unknown'

    try {
      await next()
      if (ctx.config.metric && ctx.response && ctx.response.status) {
        status = statusLabel(ctx.response.status)
      }
    } catch (err) {
      if (ctx.config.metric) {
        if (err.code === 'ECONNABORTED') {
          status = 'aborted'
        }
        else if (err.response && err.response.data && err.response.data.code === TIMEOUT_CODE) {
          status = 'timeout'
        }
        else if (err.response && err.response.status) {
          status = statusLabel(err.response.status)
        } else {
          status = 'error'
        }
      }
      throw err
    } finally {
      const end = process.hrtime(start)
      if (ctx.config.metric && metrics) {
        const label = `http-client-${status}-${ctx.config.metric}`
        const extensions: Record<string, string | number> = {}

        if (ctx.cacheHit) {
          Object.assign(extensions, ctx.cacheHit)
        }

        if (ctx.config['axios-retry']) {
          const {retryCount} = ctx.config['axios-retry'] as any

          if (retryCount && retryCount > 0) {
            extensions[`retry-${retryCount}`] = 1
          }
        }

        metrics.batch(label, end, extensions)
      }
      if (serverTiming) {
        // Timings in the client's perspective
        serverTiming[serverTimingLabel] = `${hrToMillis(process.hrtime(serverTimingStart))}`

        // Timings in the servers's perspective
        const serverTimingsHeader = path<string>(['response', 'headers', 'server-timing'], ctx)
        if (serverTimingsHeader) {
          const parsedServerTiming = parseServerTiming(serverTimingsHeader)
          forEach(
            ([timingsName, timingsDur]) => {
              if (!serverTiming[timingsName] || Number(serverTiming[timingsName]) < Number(timingsDur)) {
                serverTiming[timingsName] = timingsDur
              }
            },
            parsedServerTiming
          )
        }
      }
    }
  }
}
