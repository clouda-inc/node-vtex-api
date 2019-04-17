import { HttpClient, withoutRecorder } from '../HttpClient'
import { HttpClientFactory, IOClientHTTP } from './IOClientHTTP'

const eventRoute = (route: string) => `/events/${route}`

const forWorkspaceWithoutRecorder: HttpClientFactory = ({service, context, options}) => (service && context)
  ? HttpClient.forWorkspace(service, withoutRecorder(context), options || {})
  : undefined

export class Events extends IOClientHTTP {
  protected service = 'colossus'
  protected httpClientFactory = forWorkspaceWithoutRecorder

  public sendEvent = (subject: string, route: string, message?: any) => {
    return this.http.put(eventRoute(route), message, {params: {subject}, metric: 'events-send'})
  }
}
