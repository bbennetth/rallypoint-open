# @rallypoint/events-client

Typed client SDK for the Rallypoint Events **public** API surface
(`/api/v1/sdk/events/**`). Read-only: fetch a published event's shell,
lineup, and sessions. The surface is unauthenticated and content-gated
(a `404` unless the event's public page is enabled and the event is not
private), so **no API key is required**.

## Usage

```ts
import { createEventsClient } from '@rallypoint/events-client'

const events = createEventsClient({
  baseUrl: 'https://events.rallypt.app', // no trailing slash needed
})

const event = await events.getEvent('sunset-fest')
const lineup = await events.getLineup('sunset-fest')
const sessions = await events.getSessions('sunset-fest', { dayId: 'day_123' })
```

Non-2xx responses throw `EventsClientError` carrying the parsed error
envelope (`status`, `code`, `message`, `details`):

```ts
import { EventsClientError } from '@rallypoint/events-client'

try {
  await events.getEvent('does-not-exist')
} catch (err) {
  if (err instanceof EventsClientError && err.status === 404) {
    // event is missing, private, or its public page is disabled
  }
}
```

### Options

- `baseUrl` — origin of events-api (e.g. `https://events.rallypt.app`).
- `apiKey` — optional bearer token. The public surface needs none; supply
  one only for a future authenticated surface.
- `fetch` — optional `fetch` override for tests or non-browser runtimes.
