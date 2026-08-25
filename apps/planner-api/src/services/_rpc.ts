export type RpcReturn<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>
