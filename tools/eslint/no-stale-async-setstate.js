// ESLint rule: flag React state commits (`set[A-Z]…()`) that run after an
// `await` — or inside a `.then`/`.catch` callback — without a staleness guard.
// See stale-async-core.js for the heuristic and its rationale. Scoped (via
// eslint.config.js) to `apps/*/src/**/*.tsx`, where the mount-stable /
// param-changing race actually bites.
//
// The accepted false-positive class is user-action handlers (submit/click):
// they setState after an await but the component is mounted with no competing
// generation, so a stale overwrite can't happen. Resolve those with a
// justified inline disable rather than weakening the rule.

import { analyzeFunction, collectRacyFunctionNodes } from './stale-async-core.js'

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require a staleness guard (useAsyncTask/ctx.stale or an active flag) before committing state after an await',
      recommended: false,
    },
    schema: [],
    messages: {
      staleSetState:
        'State committed after an await without a staleness guard — a stale response can overwrite fresher state (or a param-change race can mis-target writes). Wrap the load in useAsyncTask()/useAsync() from @rallypoint/web-kit and `if (ctx.stale()) return` before this setter, or guard it with an active flag.',
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        // Only lifecycle-reachable functions can host the mount-stable /
        // param-change race; user-action handlers are excluded so the rule
        // stays at the actual finding instead of every setState-after-await.
        for (const fn of collectRacyFunctionNodes(program)) {
          for (const setter of analyzeFunction(fn)) {
            context.report({ node: setter, messageId: 'staleSetState' })
          }
        }
      },
    }
  },
}

export default {
  rules: {
    'no-stale-async-setstate': rule,
  },
}
