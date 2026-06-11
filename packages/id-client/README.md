# @rallypoint/id-client

Tiny SDK for verifying [Rallypoint ID](https://github.com/bbennetth/rallypoint-core)
sessions and pointing browsers at the hosted UI.

```sh
npm install @rallypoint/id-client
```

## Server-side: verify a session

For Pages Functions / Lambda / Express / Hono / etc.

```ts
import { SessionVerifier } from '@rallypoint/id-client'

const verifier = new SessionVerifier({
  apiBase: 'https://id.rallypt.app',
  // cacheTtlMs: 30_000, // default
})

// Per-request:
const token = readBearer(req) // your extractor
const result = await verifier.verifySession(token)
if (!result.ok) return new Response('Unauthorized', { status: 401 })
const user = result.user // OIDC-shape userinfo
```

`SessionVerifier` keeps a small in-process LRU cache (default 30s
TTL / 1000 entries) of both successful and rejected lookups. The
cache key is `SHA-256(token)`, so a heap dump doesn't expose the
bearer. Construct one `SessionVerifier` per long-lived process;
in serverless contexts where the process recycles per-request,
use `verifySessionOnce(token, opts)` for the same wire format
without the cache.

`result.user` shape (OIDC userinfo superset):

```ts
{
  sub: 'user_01HX...'   // ULID-prefixed user id
  email: string
  email_verified: boolean
  preferred_username: string
  name: string | null
  picture: string | null
  updated_at: string    // ISO-8601
}
```

## Server-side: redirect a user to sign in

```ts
import { signinUrl, signupUrl } from '@rallypoint/id-client'

const url = signinUrl({
  hostedUiUrl: 'https://id.rallypt.app',
  returnTo: 'https://app.example.com/dashboard',
  loginHint: 'alice@example.com', // optional
})
return Response.redirect(url, 302)
```

The hosted UI sanitizes `returnTo` against its safe-redirect
allowlist before honoring it.

## React: useSession (browser only)

> Only works when the browser is on the **same origin** as the
> Rallypoint ID API. The session cookie is host-isolated via the
> `__Host-` prefix, so cross-origin React apps must use the
> server-side `verifySession()` flow instead.

```tsx
import { useSession } from '@rallypoint/id-client/react'

function Header() {
  const { status, user, refetch } = useSession()
  if (status === 'loading') return <Spinner />
  if (status === 'unauthenticated') return <SigninButton />
  if (status === 'error') return <Retry onClick={refetch} />
  return <Greeting name={user!.preferred_username} />
}
```

## License

Apache-2.0.
