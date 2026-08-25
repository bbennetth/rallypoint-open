import type { R2Bucket, Service } from '@cloudflare/workers-types'
import { createBindingObjectStore } from '@rallypoint/object-store'
import type { IdRPC } from '@rallypoint/id-api'
import type { EventsRPC } from '@rallypoint/events-api'
import type { Env } from '../env.js'
import { createIdClientService } from './id-client.js'
import { createRpidSsoService } from './rpid-sso.js'
import { createSettingsClientService } from './settings.js'
import { createProfilesClientService } from './profiles.js'
import { createVisionService } from './vision.js'
import { createFoodVisionService } from './food-vision.js'
import { createSubmissionScanService } from './submission-ai-scan.js'
import { createOffClient } from './off-client.js'
import { createWeatherService } from './weather.js'
import { createWebPushService } from './push.js'
import type { AiBinding } from './vision-chat.js'
import type { AiTracesRpc } from '@rallypoint/ai'
import type { RestAlarmService, Services } from './types.js'

// `opts` carries the typed `Service<IdRPC>` binding + the Workers AI
// binding from the Worker entry (worker.ts). Fitness's catch-up to
// feat/rpc-bindings: services delegate directly to IdRPC; the
// FITNESS_API_KEY-bearer HTTP path is gone.
export function buildServices(
  env: Env,
  opts?: {
    rpid?: Service<IdRPC> | undefined
    ai?: AiBinding | undefined
    events?: Service<EventsRPC> | undefined
    objectStore?: R2Bucket | undefined
    restAlarms?: RestAlarmService | undefined
    aiTraces?: AiTracesRpc | undefined
  },
): Services {
  const lazyBinding = <T>(name: string, value: T | undefined): T => {
    if (value !== undefined) return value
    const proxy = new Proxy({} as object, {
      get(_target, prop) {
        return () => {
          throw new Error(
            `fitness-api buildServices(): cross-Worker binding "${name}" is undefined ` +
              `but was just called as .${String(prop)}(). Make sure rallypoint-id is running.`,
          )
        }
      },
    })
    return proxy as T
  }
  const rpid = lazyBinding('RPID', opts?.rpid)
  const gatewayId = env.AI_GATEWAY_ID
  return {
    idClient: createIdClientService(rpid),
    rpidSso: createRpidSsoService(rpid),
    profiles: createProfilesClientService(rpid),
    settings: createSettingsClientService(rpid),
    vision: opts?.ai ? createVisionService(opts.ai, gatewayId) : null,
    foodVision: opts?.ai ? createFoodVisionService(opts.ai, gatewayId) : null,
    submissionScans: opts?.ai ? createSubmissionScanService(opts.ai, gatewayId) : null,
    offClient: createOffClient(fetch, { fdcApiKey: env.FDC_API_KEY }),
    weather: opts?.events ? createWeatherService(opts.events) : null,
    objectStore: opts?.objectStore ? createBindingObjectStore(opts.objectStore) : null,
    webPush: createWebPushService({
      vapid: {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },
    }),
    restAlarms: opts?.restAlarms ?? null,
    aiTraces: opts?.aiTraces ?? null,
  }
}

export type { Services } from './types.js'
