import { IOClients } from '../../../../clients/IOClients'
import { insertUserLandTracer, nameSpanOperationMiddleware, traceUserLandRemainingPipelineMiddleware } from '../../../tracing/tracingMiddlewares'
import { clients } from '../http/middlewares/clients'
import { error } from '../http/middlewares/error'
import { getServiceSettings } from '../http/middlewares/settings'
import { timings } from '../http/middlewares/timings'
import {
  ClientsConfig,
  EventHandler,
  ParamsContext,
  RecorderState,
  RouteSettingsType,
  ServiceContext,
} from '../typings'
import { compose, composeForEvents } from '../utils/compose'
import { toArray } from '../utils/toArray'
import { parseBodyMiddleware } from './middlewares/body'
import { eventContextMiddleware } from './middlewares/context'

interface ServiceEvent {
  [handler: string]: {
    keys?: string[] | undefined
    sender?: string | undefined
    subject?: string | undefined
    settingsType?: RouteSettingsType
  }
}

export const createEventHandler = <T extends IOClients, U extends RecorderState, V extends ParamsContext>(
  clientsConfig: ClientsConfig<T>,
  eventId: string,
  handler: EventHandler<T, U> | Array<EventHandler<T, U>>,
  serviceEvents?: ServiceEvent
) => {
  const { implementation, options } = clientsConfig
  const middlewares = toArray(handler)
  const pipeline = [
    nameSpanOperationMiddleware('event-handler', eventId),
    eventContextMiddleware,
    parseBodyMiddleware,
    insertUserLandTracer,
    clients<T, U, V>(implementation!, options),
    ...(serviceEvents?.settingsType === 'workspace' || serviceEvents?.settingsType === 'userAndWorkspace' ? [getServiceSettings()] : []),
    timings,
    error,
    traceUserLandRemainingPipelineMiddleware(`user-event-handler:${eventId}`),
    contextAdapter<T, U, V>(middlewares),
  ]
  return compose(pipeline)
}

function contextAdapter<T extends IOClients, U extends RecorderState, V extends ParamsContext> (middlewares: Array<EventHandler<T, U>>) {
  return  async function  middlewareCascade(ctx: ServiceContext<T, U, V>) {
    const ctxEvent = {
      body: (ctx.state as any).body,
      clients: ctx.clients,
      key: ctx.vtex.eventInfo? ctx.vtex.eventInfo.key : '',
      metrics: ctx.metrics,
      sender: ctx.vtex.eventInfo? ctx.vtex.eventInfo.sender : '',
      state: ctx.state,
      subject: ctx.vtex.eventInfo? ctx.vtex.eventInfo.subject : '',
      timings: ctx.timings,
      vtex: ctx.vtex,
    }
    await composeForEvents<T, U>(middlewares)(ctxEvent)
    ctx.status = 204
  }
}
