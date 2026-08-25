/* eslint-disable @typescript-eslint/no-explicit-any -- ESTree nodes are walked
   untyped here; typing the whole AST surface would add noise without value. */
import { describe, it, expect } from 'vitest'
import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import plugin from './no-stale-async-setstate.js'
import {
  isSetterName,
  guardKind,
  analyzeFunction,
  collectRacyFunctionNodes,
  getFunctionName,
  FUNCTION_TYPES,
} from './stale-async-core.js'

// ── Test helpers ──────────────────────────────────────────────────────────

// Raw parser output has no `.parent` links (ESLint sets those during
// traversal); the core relies on them, so wire them up for direct unit tests.
function setParents(root: unknown): unknown {
  const visit = (node: any) => {
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const el of value)
          if (el && typeof el === 'object' && typeof el.type === 'string') {
            el.parent = node
            visit(el)
          }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        value.parent = node
        visit(value)
      }
    }
  }
  visit(root)
  return root
}

function parse(code: string): any {
  const ast = tsParser.parse(code, {
    ecmaVersion: 2023,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
    loc: true,
    range: true,
  })
  return setParents(ast)
}

function allFunctions(ast: any): any[] {
  const out: any[] = []
  const visit = (node: any) => {
    if (FUNCTION_TYPES.has(node.type)) out.push(node)
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const el of value) if (el && typeof el === 'object' && typeof el.type === 'string') visit(el)
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visit(value)
      }
    }
  }
  visit(ast)
  return out
}

/** analyzeFunction on the first function in a snippet → count of reported setters. */
function reportCount(code: string): number {
  const fn = allFunctions(parse(code))[0]
  return analyzeFunction(fn).length
}

// ── analyzeFunction: taint / guard logic (independent of lifecycle gating) ──

describe('analyzeFunction', () => {
  it('does not flag a setter before the first await (loading reset)', () => {
    expect(reportCount(`async () => { setState({ loading: true }); await foo() }`)).toBe(0)
  })

  it('flags a bare await → setState', () => {
    expect(reportCount(`async () => { const e = await getEvent(id); setState(e) }`)).toBe(1)
  })

  it('is cleared by ctx.stale() before the commit', () => {
    expect(
      reportCount(`async (ctx) => { const e = await getEvent(id); if (ctx.stale()) return; setState(e) }`),
    ).toBe(0)
  })

  it('re-taints after a second await past an earlier guard', () => {
    expect(
      reportCount(`async (ctx) => {
        const a = await f1(); if (ctx.stale()) return;
        const b = await f2(); setData(b)
      }`),
    ).toBe(1)
  })

  it('flags an unguarded commit in the catch branch when the try awaited', () => {
    expect(
      reportCount(`async (ctx) => {
        try { const e = await getEvent(id); if (ctx.stale()) return; setState({ event: e }) }
        catch (err) { setState({ error: true }) }
      }`),
    ).toBe(1)
  })

  it('treats a positive active-flag wrap as a guard', () => {
    // A .then callback body: initial taint true. `if (active) setState()` guards.
    const fn = allFunctions(parse(`getX().then((x) => { if (active) setState(x) })`)).find(
      (f) => f.params.length === 1,
    )
    expect(analyzeFunction(fn).length).toBe(0)
  })

  it('flags the else of an if(active) wrap', () => {
    const fn = allFunctions(
      parse(`getX().then((x) => { if (active) { keep() } else { setState(x) } })`),
    ).find((f) => f.params.length === 1)
    expect(analyzeFunction(fn).length).toBe(1)
  })

  it('treats a signal.aborted check as a guard', () => {
    expect(
      reportCount(`async (ctx) => { const x = await f(); if (!ctx.signal.aborted) setState(x) }`),
    ).toBe(0)
  })
})

// ── collectRacyFunctionNodes: lifecycle reachability ────────────────────────

describe('collectRacyFunctionNodes', () => {
  const names = (ast: any) =>
    collectRacyFunctionNodes(ast)
      .map((fn: any) => getFunctionName(fn))
      .filter(Boolean)
      .sort()

  it('reaches a load called inside a useEffect body', () => {
    const ast = parse(`
      function Page() {
        async function load() { const e = await get(); setS(e) }
        function handleSave() { save() }
        useEffect(() => { load() }, [])
      }`)
    expect(names(ast)).toContain('load')
    expect(names(ast)).not.toContain('handleSave')
  })

  it('reaches a load listed in a useEffect dependency array', () => {
    const ast = parse(`
      function Page() {
        const load = useCallback(() => { getX().then((x) => setS(x)) }, [id])
        useEffect(() => { load() }, [load])
      }`)
    expect(names(ast)).toContain('load')
  })

  it('does not reach a pure event handler', () => {
    const ast = parse(`
      function Page() {
        async function handleSubmit() { const r = await save(); setDone(r) }
        return <button onClick={handleSubmit} />
      }`)
    expect(collectRacyFunctionNodes(ast).length).toBe(0)
  })
})

// ── Full rule (lifecycle gating + taint analysis) ───────────────────────────

RuleTester.describe = describe
RuleTester.it = it

const rule = plugin.rules['no-stale-async-setstate']
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-stale-async-setstate', rule, {
  valid: [
    // A user-action handler that setStates after an await is NOT a lifecycle
    // race — not reachable from an effect, so not flagged.
    {
      code: `function Page() {
        async function handleSave() { const r = await save(); setX(r) }
        return <button onClick={handleSave} />
      }`,
    },
    // Effect-wired load, guarded with ctx.stale().
    {
      code: `function Page() {
        const run = useAsyncTask()
        const load = useCallback(
          () => run(async (ctx) => { const e = await get(); if (ctx.stale()) return; setS(e) }),
          [run],
        )
        useEffect(() => { load() }, [load])
      }`,
    },
    // Effect-wired load, manual active-flag guard on the .then.
    {
      code: `function Page() {
        useEffect(() => {
          let active = true
          listX().then((lists) => { if (active) setS(lists) })
          return () => { active = false }
        }, [])
      }`,
    },
    // A load defined but never wired to a lifecycle is out of scope.
    {
      code: `function Page() {
        async function load() { const e = await get(); setS(e) }
        return <button onClick={() => load()} />
      }`,
    },
    // A negated-flag logical guard (id-web AuthAlternatives shape).
    {
      code: `function Page() {
        useEffect(() => {
          let cancelled = false
          get().then((r) => { if (!cancelled && r.ok) setS(r.data) })
          return () => { cancelled = true }
        }, [])
      }`,
    },
    // A nested async function declaration, guarded, called from the effect.
    // Its awaits must not taint sibling statements of the effect, and its
    // guarded setter must not be misattributed to the effect callback.
    {
      code: `function Page() {
        useEffect(() => {
          let cancelled = false
          async function start() {
            const x = await get()
            if (cancelled) return
            setReady(x)
          }
          void start()
          return () => { cancelled = true }
        }, [])
      }`,
    },
  ],
  invalid: [
    // Effect calls an unguarded load.
    {
      code: `function Page() {
        async function load() { const e = await get(); setS(e) }
        useEffect(() => { load() }, [])
      }`,
      errors: [{ messageId: 'staleSetState' }],
    },
    // Effect-wired load using the .then shape (GroupDetailPage).
    {
      code: `function Page() {
        const load = useCallback(() => { getGroup(id).then((g) => setS(g)) }, [id])
        useEffect(() => { load() }, [load])
      }`,
      errors: [{ messageId: 'staleSetState' }],
    },
    // Effect body itself awaits then commits, unguarded, in both try and catch.
    {
      code: `function Page() {
        useEffect(() => {
          void (async () => {
            try { const e = await get(); setS(e) } catch { setErr(true) }
          })()
        }, [id])
      }`,
      errors: [{ messageId: 'staleSetState' }, { messageId: 'staleSetState' }],
    },
    // A nested async function declaration with an UNguarded setter, called from
    // the effect: flagged once (in the nested function's own analysis), not
    // duplicated by the effect callback, and its await doesn't taint siblings.
    {
      code: `function Page() {
        useEffect(() => {
          async function start() {
            const x = await get()
            setReady(x)
          }
          void start()
        }, [])
      }`,
      errors: [{ messageId: 'staleSetState' }],
    },
    // A mixed-operator guard is unsound (`unrelated && cancelled` being false
    // doesn't imply cancelled is false), so it is NOT credited — the commit
    // after it is still flagged.
    {
      code: `function Page() {
        useEffect(() => {
          async function start() {
            const x = await get()
            if (unrelated && cancelled) return
            setReady(x)
          }
          void start()
        }, [])
      }`,
      errors: [{ messageId: 'staleSetState' }],
    },
  ],
})

// ── Predicates ──────────────────────────────────────────────────────────────

describe('stale-async-core predicates', () => {
  it('recognizes React setter names', () => {
    expect(isSetterName('setState')).toBe(true)
    expect(isSetterName('setLoading')).toBe(true)
    expect(isSetterName('setter')).toBe(false)
    expect(isSetterName('handleSet')).toBe(false)
    expect(isSetterName('settle')).toBe(false)
  })

  it('classifies if-test guards, resolving negation', () => {
    const stale = () => ({
      type: 'CallExpression',
      callee: { type: 'MemberExpression', property: { type: 'Identifier', name: 'stale' } },
    })
    expect(guardKind(stale())).toBe('stale')
    expect(guardKind({ type: 'UnaryExpression', operator: '!', argument: stale() })).toBe('active')
    expect(guardKind({ type: 'Identifier', name: 'active' })).toBe('active')
    expect(
      guardKind({ type: 'UnaryExpression', operator: '!', argument: { type: 'Identifier', name: 'active' } }),
    ).toBe('stale')
    expect(guardKind({ type: 'Identifier', name: 'cancelled' })).toBe('stale')
    expect(guardKind({ type: 'Identifier', name: 'somethingElse' })).toBe(null)
  })

  it('recognizes an isStale…() helper call as a stale guard', () => {
    const call = { type: 'CallExpression', callee: { type: 'Identifier', name: 'isStaleGeneration' }, arguments: [] }
    expect(guardKind(call)).toBe('stale')
    expect(guardKind({ type: 'UnaryExpression', operator: '!', argument: call })).toBe('active')
  })

  it('recognizes a negated operand inside a logical guard', () => {
    // `!cancelled && r.ok` — the guard the id-web AuthAlternatives effect uses.
    const test = {
      type: 'LogicalExpression',
      operator: '&&',
      left: { type: 'UnaryExpression', operator: '!', argument: { type: 'Identifier', name: 'cancelled' } },
      right: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'r' },
        property: { type: 'Identifier', name: 'ok' },
      },
    }
    expect(guardKind(test)).toBe('active')
  })

  it('recognizes a stale operand in a multi-term logical bail', () => {
    // `cancelled || !res || mySeq !== seq` — MigrationOfferGate's guard.
    const test = {
      type: 'LogicalExpression',
      operator: '||',
      left: {
        type: 'LogicalExpression',
        operator: '||',
        left: { type: 'Identifier', name: 'cancelled' },
        right: { type: 'UnaryExpression', operator: '!', argument: { type: 'Identifier', name: 'res' } },
      },
      right: {
        type: 'BinaryExpression',
        operator: '!==',
        left: { type: 'Identifier', name: 'mySeq' },
        right: { type: 'Identifier', name: 'seq' },
      },
    }
    expect(guardKind(test)).toBe('stale')
  })

  it('propagates a classification only through the sound connective', () => {
    const id = (name: string) => ({ type: 'Identifier', name })
    const or = (l: unknown, r: unknown) => ({ type: 'LogicalExpression', operator: '||', left: l, right: r })
    const and = (l: unknown, r: unknown) => ({ type: 'LogicalExpression', operator: '&&', left: l, right: r })
    // Sound: stale through ||, active through &&.
    expect(guardKind(or(id('cancelled'), id('busy')))).toBe('stale')
    expect(guardKind(and(id('active'), id('ready')))).toBe('active')
    // Unsound and therefore NOT credited: a stale leaf reached through && ...
    expect(guardKind(and(id('unrelated'), or(id('busy'), id('cancelled'))))).toBe(null)
    // ... and an active leaf reached through ||.
    expect(guardKind(or(id('active'), id('busy')))).toBe(null)
  })

  it('recognizes a generation-ref comparison guard', () => {
    const refCurrent = {
      type: 'MemberExpression',
      computed: false,
      object: { type: 'Identifier', name: 'genRef' },
      property: { type: 'Identifier', name: 'current' },
    }
    const gen = { type: 'Identifier', name: 'generation' }
    // `generation !== genRef.current` → bail (stale); `===` → safe (active).
    expect(guardKind({ type: 'BinaryExpression', operator: '!==', left: gen, right: refCurrent })).toBe('stale')
    expect(guardKind({ type: 'BinaryExpression', operator: '===', left: gen, right: refCurrent })).toBe('active')
    // A literal comparison against .current (e.g. `ref.current !== null`) is NOT a guard.
    expect(
      guardKind({
        type: 'BinaryExpression',
        operator: '!==',
        left: refCurrent,
        right: { type: 'Literal', value: null },
      }),
    ).toBe(null)
  })
})
