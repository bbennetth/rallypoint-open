// Helpers for working with `Service<XRPC>` bindings. See
// apps/events-api/src/services/_rpc.ts for the rationale (Cloudflare's
// Service<T> Result wrapper drops union branches that fail Serializable,
// so consumers cast back to the entrypoint's actual return type).

export type RpcReturn<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>
