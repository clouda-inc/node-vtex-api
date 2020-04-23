import { AxiosError } from 'axios'
import { IncomingMessage } from 'http'
import mime from 'mime-types'
import { basename } from 'path'
import { Readable } from 'stream'
import { createGzip } from 'zlib'

import {
  inflightURL,
  inflightUrlWithQuery,
  InstanceOptions,
  RequestTracingConfig,
} from '../../HttpClient'
import {
  IgnoreNotFoundRequestConfig,
} from '../../HttpClient/middlewares/notFound'
import { BucketMetadata, FileListItem } from '../../responses'
import { IOContext } from '../../service/worker/runtime/typings'
import { InfraClient } from './InfraClient'

const appId = process.env.VTEX_APP_ID
const [runningAppName] = appId ? appId.split('@') : ['']

const routes = {
  Bucket: (bucket: string) => `/buckets/${runningAppName}/${bucket}`,
  Conflicts: (bucket: string) => `/buckets/${runningAppName}/${bucket}/conflicts`,
  File: (bucket: string, path: string) => `${routes.Bucket(bucket)}/files/${path}`,
  Files: (bucket: string) => `${routes.Bucket(bucket)}/files`,
}

const isVBaseOptions = (opts?: string | VBaseOptions): opts is VBaseOptions => {
  return typeof opts !== 'string' && !(opts instanceof String)
}

export class VBase extends InfraClient {
  constructor (context: IOContext, options?: InstanceOptions) {
    super('vbase@2.x', context, options)
    if (runningAppName === '') {
      throw new Error(`Invalid path to access VBase. Variable VTEX_APP_ID is not available.`)
    }
  }

  public getBucket = (bucket: string, tracingConfig?: RequestTracingConfig) => {
    const inflightKey = inflightURL
    const metric = 'vbase-get-bucket'
    return this.http.get<BucketMetadata>(routes.Bucket(bucket), {inflightKey, metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public resetBucket = (bucket: string, tracingConfig?: RequestTracingConfig) => {
    const metric = 'vbase-reset-bucket'
    return this.http.delete(routes.Files(bucket), {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public listFiles = (bucket: string, opts?: string | VBaseOptions, tracingConfig?: RequestTracingConfig) => {
    let params: VBaseOptions = {}
    if (isVBaseOptions(opts)) {
      params = opts
    } else if (opts) {
      params = {prefix: opts}
    }
    const metric = 'vbase-list'
    const inflightKey = inflightUrlWithQuery
    return this.http.get<BucketFileList>(routes.Files(bucket), {inflightKey, metric, params, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public getFile = (bucket: string, path: string, tracingConfig?: RequestTracingConfig) => {
    const inflightKey = inflightURL
    const metric = 'vbase-get-file'
    return this.http.getBuffer(routes.File(bucket, path), {inflightKey, metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public getJSON = <T>(bucket: string, path: string, nullIfNotFound?: boolean, conflictsResolver?: ConflictsResolver<T>, tracingConfig?: RequestTracingConfig) => {
    const headers = conflictsResolver? {'X-Vtex-Detect-Conflicts': true}: {}
    const inflightKey = inflightURL
    const metric = 'vbase-get-json'
    return this.http.get<T>(routes.File(bucket, path), { headers, inflightKey, metric, nullIfNotFound, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }} as IgnoreNotFoundRequestConfig)
      .catch((error: AxiosError) => {
        const { response } = error
        if (response && response.status === 409 && conflictsResolver) {
          return conflictsResolver.resolve()
        }
        throw error
      })
  }

  public getFileStream = (bucket: string, path: string, tracingConfig?: RequestTracingConfig): Promise<IncomingMessage> => {
    const metric = 'vbase-get-file-s'
    return this.http.getStream(routes.File(bucket, path), {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public saveFile = (bucket: string, path: string, stream: Readable, gzip: boolean = true, ttl?: number, tracingConfig?: RequestTracingConfig) => {
    return this.saveContent(bucket, path, stream, {gzip, ttl }, tracingConfig)
  }

  public getFileMetadata = (bucket:string, path:string, tracingConfig?: RequestTracingConfig) => {
    const metric = 'vbase-get-file-metadata'
    return this.http.head(routes.File(bucket, path), {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public saveJSON = <T>(bucket: string, path: string, data: T, tracingConfig?: RequestTracingConfig) => {
    const headers = {'Content-Type': 'application/json'}
    const metric = 'vbase-save-json'
    return this.http.put(routes.File(bucket, path), data, {headers, metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public saveZippedContent = (bucket: string, path: string, stream: Readable, tracingConfig?: RequestTracingConfig) => {
    return this.saveContent(bucket, path, stream, {unzip: true}, tracingConfig)
  }

  public deleteFile = (bucket: string, path: string, tracingConfig?: RequestTracingConfig) => {
    const metric = 'vbase-delete-file'
    return this.http.delete(routes.File(bucket, path), {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public getConflicts = <T>(bucket: string, tracingConfig?: RequestTracingConfig) => {
    const metric = 'vbase-get-conflicts'
    return this.http.get<T>(routes.Conflicts(bucket), {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  public resolveConflict = <T>(bucket: string, path: string, content: any, tracingConfig?: RequestTracingConfig) => {
    const data = [{
      op: 'replace',
      path,
      value: content,
    }]

    const metric = 'vbase-resolve-conflicts'
    return this.http.patch<T>(routes.Conflicts(bucket), data,  {metric, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }

  private saveContent = (bucket: string, path: string, stream: Readable, opts: VBaseSaveOptions = {}, tracingConfig?: RequestTracingConfig) => {
    if (!stream.pipe || !stream.on) {
      throw new Error(`Argument stream must be a readable stream`)
    }
    const params = opts.unzip ? {unzip: opts.unzip} : {}
    const headers: Headers = {}

    let finalStream = stream
    headers['Content-Type'] = mime.contentType(basename(path)) || 'application/octet-stream'
    if (opts.gzip) {
      headers['Content-Encoding'] = 'gzip'
      finalStream = stream.pipe(createGzip())
    }
    if (opts.ttl && Number.isInteger(opts.ttl)) {
      headers['X-VTEX-TTL'] = opts.ttl
    }
    const metric = 'vbase-save-blob'
    return this.http.put(routes.File(bucket, path), finalStream, {headers, metric, params, tracing: {
      requestSpanNameSuffix: metric,
      ...tracingConfig?.tracing,
    }})
  }
}

interface Headers { [key: string]: string | number }

export interface BucketFileList {
  data: FileListItem[],
  next: string,
  smartCacheHeaders: any,
}

export interface VBaseOptions {
  prefix?: string,
  next?: string,
  limit?: number,
}

export interface VBaseSaveOptions {
  gzip?: boolean,
  unzip?: boolean,
  ttl?: number,
}

export interface VBaseConflictData{
  path: string,
  base: VBaseConflict,
  master: VBaseConflict,
  mine: VBaseConflict
}

export interface VBaseConflict{
  contentOmitted: boolean,
  deleted: boolean,
  mimeType: string,
  parsedContent?: any,
  content: string,
}

export interface ConflictsResolver<T>{
  resolve: () => T | Promise<T>
}