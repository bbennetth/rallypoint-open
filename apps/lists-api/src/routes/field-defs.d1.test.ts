import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { LISTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the custom field-definition surface.
// Replaces field-defs.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — list field defs', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u: string, _n: string, p: Record<string, unknown>) => p,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(LISTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { LISTS_SESSION_KEY_V1: envVars.LISTS_SESSION_KEY_V1 },
      keyVersion: envVars.LISTS_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.LISTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.LISTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  // Creates a group + a list in it, returning both ids so tests can add
  // extra members to the scope.
  async function makeList(bearer: string): Promise<{ listId: string; groupId: string }> {
    const groupRes = await req(bearer, 'POST', '/api/v1/ui/groups', {
      name: `Group ${Date.now()}_${Math.random().toString(36).slice(2)}`,
    })
    const groupId = ((await groupRes.json()) as { id: string }).id
    const listRes = await req(bearer, 'POST', '/api/v1/ui/lists', {
      name: 'List',
      listType: 'standard',
      scopeType: 'list_group',
      scopeId: groupId,
    })
    expect(listRes.status).toBe(201)
    return { listId: ((await listRes.json()) as { id: string }).id, groupId }
  }

  it('creates a field, derives a slug key, and lists it back', async () => {
    const bearer = await loginAs(`user_${Date.now()}_creator`)
    const { listId } = await makeList(bearer)

    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Budget (USD)',
      fieldType: 'number',
    })
    expect(res.status).toBe(201)
    const def = (await res.json()) as Record<string, unknown>
    expect(def.id).toMatch(/^lfd_/)
    expect(def.key).toBe('budget_usd')
    expect(def.field_type).toBe('number')
    expect(def.required).toBe(false)
    expect(def.position).toBe(0)

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/fields`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]!.id).toBe(def.id)
  })

  it('mints stable option ids for a select field and de-dupes colliding keys', async () => {
    const bearer = await loginAs(`user_${Date.now()}_select`)
    const { listId } = await makeList(bearer)

    const first = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Store',
      fieldType: 'single_select',
      choices: [{ label: 'Costco' }, { label: 'Target', color: 'red' }],
    })).json()) as { key: string; options: { choices: Array<{ id: string; label: string }> } }
    expect(first.key).toBe('store')
    expect(first.options.choices).toHaveLength(2)
    expect(first.options.choices[0]!.id).toMatch(/^opt_/)
    expect(first.options.choices[1]!.id).toMatch(/^opt_/)
    expect(first.options.choices[0]!.id).not.toBe(first.options.choices[1]!.id)

    // A second field with the same label gets a de-duped key.
    const second = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Store',
      fieldType: 'text',
    })).json()) as { key: string }
    expect(second.key).toBe('store_2')
  })

  it('rejects a select field with no choices (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_nochoice`)
    const { listId } = await makeList(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Status',
      fieldType: 'single_select',
    })
    expect(res.status).toBe(400)
  })

  it('renames a field and archives a choice without dropping it', async () => {
    const bearer = await loginAs(`user_${Date.now()}_edit`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Priority',
      fieldType: 'single_select',
      choices: [{ label: 'Low' }, { label: 'High' }],
    })).json()) as { id: string; options: { choices: Array<{ id: string; label: string }> } }
    const lowId = def.options.choices[0]!.id

    const patched = (await (await req(
      bearer,
      'PATCH',
      `/api/v1/ui/lists/${listId}/fields/${def.id}`,
      {
        label: 'Urgency',
        choices: [{ id: lowId, label: 'Low', archived: true }],
      },
    )).json()) as {
      label: string
      options: { choices: Array<{ id: string; label: string; archived?: boolean }> }
    }
    expect(patched.label).toBe('Urgency')
    // Low archived, High preserved (anti-orphan).
    expect(patched.options.choices).toHaveLength(2)
    expect(patched.options.choices.find((c) => c.id === lowId)!.archived).toBe(true)
    expect(patched.options.choices.some((c) => c.label === 'High')).toBe(true)
  })

  it('rejects choices on a non-select field via PATCH (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_badpatch`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Count',
      fieldType: 'number',
    })).json()) as { id: string }
    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      choices: [{ label: 'nope' }],
    })
    expect(res.status).toBe(400)
  })

  it('soft-deletes a field and frees its key for reuse', async () => {
    const bearer = await loginAs(`user_${Date.now()}_del`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Temp',
      fieldType: 'text',
    })).json()) as { id: string; key: string }

    const delRes = await req(bearer, 'DELETE', `/api/v1/ui/lists/${listId}/fields/${def.id}`)
    expect(delRes.status).toBe(204)

    const listed = (await (await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/fields`)).json()) as {
      items: Array<Record<string, unknown>>
    }
    expect(listed.items).toHaveLength(0)

    // The freed slug can be reused (partial-unique only constrains live rows).
    const reborn = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Temp',
      fieldType: 'text',
    })).json()) as { key: string }
    expect(reborn.key).toBe('temp')
  })

  it('forbids a non-creator member from defining a field (403)', async () => {
    const owner = `user_${Date.now()}_o`
    const ownerBearer = await loginAs(owner)
    const { listId, groupId } = await makeList(ownerBearer)

    // A second user joins the scope so they can READ the (visibility=all)
    // list, but they are not the list creator.
    const member = `user_${Date.now()}_m`
    await repos.groups.addMember({
      id: `lgm_test_${Date.now()}`,
      groupId,
      userId: member,
      role: 'member',
    })
    const memberBearer = await loginAs(member)

    // The member can read the fields...
    const getRes = await req(memberBearer, 'GET', `/api/v1/ui/lists/${listId}/fields`)
    expect(getRes.status).toBe(200)

    // ...but cannot define one.
    const postRes = await req(memberBearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Sneaky',
      fieldType: 'text',
    })
    expect(postRes.status).toBe(403)
    expect(((await postRes.json()) as { error: { code: string } }).error.code).toBe('forbidden')

    // The creator-write guard fronts PATCH and DELETE too.
    const def = (await (await req(ownerBearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'OwnerField',
      fieldType: 'text',
    })).json()) as { id: string }
    const patchRes = await req(memberBearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      label: 'Hijack',
    })
    expect(patchRes.status).toBe(403)
    const delRes = await req(memberBearer, 'DELETE', `/api/v1/ui/lists/${listId}/fields/${def.id}`)
    expect(delRes.status).toBe(403)
  })

  it('404s a field that belongs to a different list', async () => {
    const bearer = await loginAs(`user_${Date.now()}_iso`)
    const a = await makeList(bearer)
    const b = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${a.listId}/fields`, {
      label: 'OnlyOnA',
      fieldType: 'text',
    })).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${b.listId}/fields/${def.id}`, {
      label: 'Hijack',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('field_def_not_found')
  })

  it('hides a field surface from a non-member (404 on the list)', async () => {
    const ownerBearer = await loginAs(`user_${Date.now()}_priv`)
    const { listId } = await makeList(ownerBearer)
    const strangerBearer = await loginAs(`user_${Date.now()}_stranger`)
    const res = await req(strangerBearer, 'GET', `/api/v1/ui/lists/${listId}/fields`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_not_found')
  })

  // --- #258: a required select must keep ≥1 active choice --------------

  it('rejects creating a required select whose only choice is already archived (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_createstrand`)
    const { listId } = await makeList(bearer)
    const res = await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Status',
      fieldType: 'single_select',
      required: true,
      choices: [{ label: 'X', archived: true }],
    })
    expect(res.status).toBe(400)
  })

  it('rejects archiving the last active choice of a required multi_select (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_reqmulti`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Tags',
      fieldType: 'multi_select',
      required: true,
      choices: [{ label: 'A' }],
    })).json()) as { id: string; options: { choices: Array<{ id: string }> } }
    const aId = def.options.choices[0]!.id

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      choices: [{ id: aId, label: 'A', archived: true }],
    })
    expect(res.status).toBe(400)
  })

  it('rejects archiving the last active choice of a required select (400) and leaves it intact', async () => {
    const bearer = await loginAs(`user_${Date.now()}_reqsel`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Status',
      fieldType: 'single_select',
      required: true,
      choices: [{ label: 'Open' }],
    })).json()) as { id: string; options: { choices: Array<{ id: string }> } }
    const onlyId = def.options.choices[0]!.id

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      choices: [{ id: onlyId, label: 'Open', archived: true }],
    })
    expect(res.status).toBe(400)

    // The reject is total: the only choice is still active.
    const listed = (await (
      await req(bearer, 'GET', `/api/v1/ui/lists/${listId}/fields`)
    ).json()) as {
      items: Array<{ id: string; options: { choices: Array<{ id: string; archived?: boolean }> } }>
    }
    const after = listed.items.find((d) => d.id === def.id)!
    expect(after.options.choices.find((c) => c.id === onlyId)!.archived).toBeUndefined()
  })

  it('allows archiving a non-last choice of a required select (200)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_reqsel2`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Priority',
      fieldType: 'single_select',
      required: true,
      choices: [{ label: 'Low' }, { label: 'High' }],
    })).json()) as { id: string; options: { choices: Array<{ id: string }> } }
    const lowId = def.options.choices[0]!.id

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      choices: [{ id: lowId, label: 'Low', archived: true }],
    })
    expect(res.status).toBe(200)
  })

  it('rejects flipping a choiceless select to required (400)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_makereq`)
    const { listId } = await makeList(bearer)
    // Optional select, then archive its only choice (allowed while optional)
    // to reach zero active choices — the state from which `required` is
    // unsatisfiable.
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Tag',
      fieldType: 'single_select',
      choices: [{ label: 'A' }],
    })).json()) as { id: string; options: { choices: Array<{ id: string }> } }
    const aId = def.options.choices[0]!.id

    const archiveRes = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      choices: [{ id: aId, label: 'A', archived: true }],
    })
    expect(archiveRes.status).toBe(200) // optional → archiving the last is fine

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      required: true,
    })
    expect(res.status).toBe(400)
  })

  it('allows flipping a select to required while it keeps an active choice (200)', async () => {
    const bearer = await loginAs(`user_${Date.now()}_makereq2`)
    const { listId } = await makeList(bearer)
    const def = (await (await req(bearer, 'POST', `/api/v1/ui/lists/${listId}/fields`, {
      label: 'Bucket',
      fieldType: 'single_select',
      choices: [{ label: 'A' }],
    })).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/lists/${listId}/fields/${def.id}`, {
      required: true,
    })
    expect(res.status).toBe(200)
  })
})
