// Pure heuristic for `no-stale-async-setstate` (see the rule wrapper alongside).
//
// The bug it catches: a page component fetches, then commits the result with a
// `setX(...)` state setter, with nothing checking that the response is still
// current. When the component stays mounted while a `useParams()` id changes
// (Back/Forward, sibling links), an older fetch resolving last overwrites the
// newer one — the screen shows entity A while the id used by writes is B. The
// fix primitive is `useAsyncTask()`/`ctx.stale()` from @rallypoint/web-kit (or
// a manual `active` cleanup flag); this heuristic flags the unguarded shape.
//
// Approach (syntactic, no type info): within a function, an `await` "taints"
// the statements that follow it; a promise callback (`.then`/`.catch`/
// `.finally` argument) starts tainted. A staleness guard clears the taint —
// either an early-return `if (ctx.stale()) return` / `if (!active) return`, or
// a positive wrap `if (active) { setX(...) }` / `if (!ctx.stale()) setX(...)`.
// A `set[A-Z]…()` call reached while tainted and unguarded is reported.
//
// Nested functions are NOT descended into during a parent's walk — each
// function is analyzed on its own (the rule wrapper visits all three function
// node types), so every setter is judged exactly once in its owning scope.

export const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

const SETTER_RE = /^set[A-Z]/
// Identifiers that read as "still current / safe to commit".
const ACTIVE_RE = /^(active|alive|mounted|live|isActive|isMounted|isAlive|subscribed|isSubscribed)$/
// Identifiers that read as "superseded / must bail".
const STALE_RE =
  /^(stale|cancelled|canceled|ignore|ignored|aborted|unmounted|discarded|superseded|didCancel|isStale|isCancelled|isCanceled)$/

/** True for `set[A-Z]…` call names (React state setters, store setters). */
export function isSetterName(name) {
  return typeof name === 'string' && SETTER_RE.test(name)
}

/**
 * A generation-gate tell: a `ctx.stale()` call, a `.aborted` / `.stale` member
 * read (AbortSignal / token), or a `isStale…`-named helper call (e.g. money-web
 * and admin-web's `isStaleGeneration(gen, genRef.current)` — a legitimate manual
 * guard equivalent to `ctx.stale()`).
 */
export function isStaleExpr(node) {
  if (!node || typeof node !== 'object') return false
  if (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'stale'
  ) {
    return true
  }
  // A helper call whose name reads as a staleness check, e.g. isStaleGeneration(...).
  if (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    /stale/i.test(node.callee.name)
  ) {
    return true
  }
  if (
    node.type === 'MemberExpression' &&
    node.property &&
    node.property.type === 'Identifier' &&
    (node.property.name === 'aborted' || node.property.name === 'stale')
  ) {
    return true
  }
  return false
}

/** A React ref read: `someRef.current` (non-computed). */
function isRefCurrent(node) {
  return (
    !!node &&
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property &&
    node.property.type === 'Identifier' &&
    node.property.name === 'current'
  )
}

// 'stale' → test being true means "bail" (guard the else / code after an exit).
// 'active' → test being true means "safe to commit" (guard the consequent).
function baseKind(node) {
  if (isStaleExpr(node)) return 'stale'
  if (node.type === 'Identifier') {
    if (STALE_RE.test(node.name)) return 'stale'
    if (ACTIVE_RE.test(node.name)) return 'active'
  }
  // Manual generation-counter guard: `myGen !== genRef.current` (bail) /
  // `myGen === genRef.current` (safe). Require the non-ref side to be an
  // identifier (the captured generation) so unrelated `ref.current !== null`
  // guards aren't misread as staleness checks.
  if (
    node.type === 'BinaryExpression' &&
    (node.operator === '!==' || node.operator === '!=' || node.operator === '===' || node.operator === '==')
  ) {
    const refSide = isRefCurrent(node.left) ? node.left : isRefCurrent(node.right) ? node.right : null
    const otherSide = refSide === node.left ? node.right : node.left
    if (refSide && otherSide && otherSide.type === 'Identifier') {
      return node.operator === '!==' || node.operator === '!=' ? 'stale' : 'active'
    }
  }
  return null
}

/** Classify an `if` test as a staleness guard, resolving `!` negation. */
export function guardKind(test) {
  let node = test
  let negate = false
  while (node && node.type === 'UnaryExpression' && node.operator === '!') {
    negate = !negate
    node = node.argument
  }
  let kind = baseKind(node)
  if (kind === null && node && node.type === 'LogicalExpression') {
    // Propagate a leaf classification up only through the sound connective:
    //  - a bail guard `if (… || cancelled) return` stays sound only if the
    //    stale leaf reaches the root through `||` (reaching past ⟹ all-false ⟹
    //    not stale); an `&&` on the path breaks that (`a && cancelled` false
    //    doesn't imply cancelled false).
    //  - a positive wrap `if (active && …) setX()` stays sound only through
    //    `&&` (test true ⟹ active true); an `||` on the path breaks it.
    // Recurse through guardKind so a negated/nested operand (`!cancelled`) and
    // its own connectives resolve correctly.
    const left = guardKind(node.left)
    const right = guardKind(node.right)
    if (node.operator === '||') kind = left === 'stale' || right === 'stale' ? 'stale' : null
    else if (node.operator === '&&') kind = left === 'active' || right === 'active' ? 'active' : null
  }
  if (kind === null) return null
  if (negate) kind = kind === 'stale' ? 'active' : 'stale'
  return kind
}

/** Iterate a node's child AST nodes (arrays and single nodes with a `.type`). */
function childNodes(node) {
  const out = []
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const el of value) if (el && typeof el === 'object' && typeof el.type === 'string') out.push(el)
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      out.push(value)
    }
  }
  return out
}

/** Collect matching descendants without entering nested function scopes. */
function collectShallow(node, match, acc) {
  if (!node) return acc
  if (match(node)) acc.push(node)
  for (const child of childNodes(node)) {
    if (FUNCTION_TYPES.has(child.type)) continue
    collectShallow(child, match, acc)
  }
  return acc
}

export function containsAwait(node) {
  return collectShallow(node, (n) => n.type === 'AwaitExpression', []).length > 0
}

function findSetterCalls(node) {
  return collectShallow(
    node,
    (n) =>
      n.type === 'CallExpression' &&
      n.callee &&
      n.callee.type === 'Identifier' &&
      isSetterName(n.callee.name),
    [],
  )
}

/** Whether a branch always leaves the enclosing block (so a guard's taint-clear holds after it). */
function branchExits(node) {
  if (!node) return false
  switch (node.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true
    case 'BlockStatement':
      return node.body.some(branchExits)
    case 'IfStatement':
      return node.alternate ? branchExits(node.consequent) && branchExits(node.alternate) : false
    default:
      return false
  }
}

// The walker threads a boolean `tainted` through statements in source order and
// pushes offending setter nodes into `report`. Each `walk*` returns the taint
// state that flows to the following statement.
function makeWalker(report) {
  function walkLeaf(stmt, tainted) {
    if (tainted) for (const setter of findSetterCalls(stmt)) report.push(setter)
    return tainted || containsAwait(stmt)
  }

  function walkStatement(stmt, tainted) {
    if (!stmt) return tainted
    switch (stmt.type) {
      case 'BlockStatement':
        return walkStatements(stmt.body, tainted)
      case 'IfStatement': {
        const kind = guardKind(stmt.test)
        const base = tainted || containsAwait(stmt.test)
        let consequentTaint = base
        let alternateTaint = base
        if (kind === 'active') consequentTaint = false
        if (kind === 'stale') alternateTaint = false
        walkStatement(stmt.consequent, consequentTaint)
        if (stmt.alternate) walkStatement(stmt.alternate, alternateTaint)
        if (kind === 'stale' && branchExits(stmt.consequent)) return false
        return base
      }
      case 'TryStatement': {
        let t = walkStatement(stmt.block, tainted)
        if (stmt.handler) {
          const catchTaint = tainted || containsAwait(stmt.block)
          walkStatement(stmt.handler.body, catchTaint)
        }
        if (stmt.finalizer) t = walkStatement(stmt.finalizer, t)
        return t
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        const bodyTaint = tainted || containsAwait(stmt)
        walkStatement(stmt.body, bodyTaint)
        return bodyTaint
      }
      case 'LabeledStatement':
        return walkStatement(stmt.body, tainted)
      case 'FunctionDeclaration':
        // A nested function declaration executes nothing at the current level;
        // its body (awaits and setters) belongs to its own analyzeFunction pass.
        // Treating it as a leaf would let its awaits taint sibling statements and
        // its setters be scanned as if they ran here (false positives).
        return tainted
      default:
        return walkLeaf(stmt, tainted)
    }
  }

  function walkStatements(statements, tainted) {
    let t = tainted
    for (const stmt of statements) t = walkStatement(stmt, t)
    return t
  }

  return { walkStatement, walkStatements }
}

/** True when `fnNode` is the callback argument of a `.then`/`.catch`/`.finally` call. */
export function isPromiseCallback(fnNode) {
  const parent = fnNode.parent
  if (!parent || parent.type !== 'CallExpression') return false
  if (!parent.arguments.includes(fnNode)) return false
  const callee = parent.callee
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.property &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'then' ||
      callee.property.name === 'catch' ||
      callee.property.name === 'finally')
  )
}

/**
 * Analyze one function node; return the setter CallExpression nodes that are
 * committed after an await / inside a promise callback without a staleness
 * guard. Pure — takes an ESTree function node, returns nodes to report.
 */
export function analyzeFunction(fnNode) {
  const report = []
  const { walkStatement, walkStatements } = makeWalker(report)
  const initialTaint = isPromiseCallback(fnNode)
  const body = fnNode.body
  if (body.type === 'BlockStatement') {
    walkStatements(body.body, initialTaint)
  } else if (initialTaint) {
    // Expression-bodied arrow used as a `.then` callback, e.g.
    // `.then((x) => setState(x))`.
    for (const setter of findSetterCalls(body)) report.push(setter)
  }
  return report
}

// ── Lifecycle reachability ────────────────────────────────────────────────
//
// A `setX()` after an await only *races* when the async work is kicked off by
// render/lifecycle (a `useEffect`, or a load function an effect invokes) — the
// component stays mounted while a `useParams()` id changes and an older fetch
// lands last. A `setX()` after an await inside a user-action handler
// (submit/click) is NOT this race: one click, one in-flight call, component
// mounted. Flagging handlers would bury the real finding under hundreds of
// benign reports, so the rule only analyzes lifecycle-reachable functions.
//
// Reachable = the callback of a `useEffect`/`useLayoutEffect`/
// `useInsertionEffect`; any function bound to a name that an effect calls at
// its top level or lists in its dependency array (the `useEffect(() => load(),
// [load])` shape); and any function lexically nested inside a reachable one
// (a `.then`/`.catch` callback inside a load).

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

function walkAll(node, visit) {
  visit(node)
  for (const child of childNodes(node)) walkAll(child, visit)
}

/** The variable/declaration name a function is bound to, if any. */
export function getFunctionName(node) {
  if (node.type === 'FunctionDeclaration' && node.id) return node.id.name
  const p = node.parent
  if (!p) return null
  if (p.type === 'VariableDeclarator' && p.id && p.id.type === 'Identifier') return p.id.name
  // const load = useCallback(fn, deps) / useMemo(() => fn, deps)
  if (
    p.type === 'CallExpression' &&
    p.parent &&
    p.parent.type === 'VariableDeclarator' &&
    p.parent.id &&
    p.parent.id.type === 'Identifier'
  ) {
    return p.parent.id.name
  }
  if (p.type === 'Property' && p.key && p.key.type === 'Identifier') return p.key.name
  return null
}

function hasReachableAncestorFunction(fnNode, reachable) {
  let n = fnNode.parent
  while (n && n.type !== 'Program') {
    if (FUNCTION_TYPES.has(n.type) && reachable.has(n)) return true
    n = n.parent
  }
  return false
}

/**
 * Return the function nodes in a parsed file that are lifecycle-reachable, and
 * thus worth analyzing for stale-commit races. Relies on `.parent` links being
 * present (true at ESLint's `Program:exit`).
 */
export function collectRacyFunctionNodes(programAst) {
  const allFunctions = []
  const functionsByName = new Map()
  const effectCallbacks = []
  const referencedNames = new Set()

  walkAll(programAst, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      allFunctions.push(node)
      const name = getFunctionName(node)
      if (name) {
        const list = functionsByName.get(name)
        if (list) list.push(node)
        else functionsByName.set(name, [node])
      }
    }
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      EFFECT_HOOKS.has(node.callee.name)
    ) {
      const cb = node.arguments[0]
      if (cb && FUNCTION_TYPES.has(cb.type)) {
        effectCallbacks.push(cb)
        const calls = collectShallow(
          cb.body,
          (n) => n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier',
          [],
        )
        for (const call of calls) referencedNames.add(call.callee.name)
      }
      const deps = node.arguments[1]
      if (deps && deps.type === 'ArrayExpression') {
        for (const el of deps.elements) if (el && el.type === 'Identifier') referencedNames.add(el.name)
      }
    }
  })

  const reachable = new Set(effectCallbacks)
  for (const name of referencedNames) {
    for (const fn of functionsByName.get(name) ?? []) reachable.add(fn)
  }
  // Expand to functions lexically nested inside a reachable one (e.g. the
  // .then callback inside a load).
  let changed = true
  while (changed) {
    changed = false
    for (const fn of allFunctions) {
      if (reachable.has(fn)) continue
      if (hasReachableAncestorFunction(fn, reachable)) {
        reachable.add(fn)
        changed = true
      }
    }
  }
  return [...reachable]
}
