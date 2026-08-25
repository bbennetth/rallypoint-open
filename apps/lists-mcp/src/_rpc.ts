// Helpers for working with Service<XRPC> bindings. See apps/events-api/src/services/_rpc.ts for the rationale.
export type RpcReturn<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>
