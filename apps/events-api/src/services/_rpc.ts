// Helpers for working with `Service<XRPC>` bindings.
//
// Cloudflare's `Service<T>` wraps each method's return through
// `Rpc.Result<R>`, which requires `R` to be `Serializable`. A
// discriminated-union return where any branch contains `unknown`
// (e.g. `customFields: Record<string, unknown>` on ListItemDto)
// trips the Serializable check and silently collapses that branch
// to `never`, so consumers see a partial type. The producer's actual
// runtime return is unchanged — only the static type is wrong.
//
// `RpcReturn` casts back to the entrypoint's internal return type so
// the consumer's branch on `result.kind` works correctly. Wrapping
// every call site in `as` casts is noisy; this helper is the one place
// the unsafe cast lives.

export type RpcReturn<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>
