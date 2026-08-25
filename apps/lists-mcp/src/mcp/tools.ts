import { z } from 'zod'
import type { CreateListItemInput, ListsClient, UpdateListItemInput } from '@rallypoint/lists-client'
import { firstDoneStatus } from '@rallypoint/lists-shared'

// MCP tool descriptor — name, description, JSON Schema (sent to clients),
// Zod schema (runtime validation), and the execution function.
export interface ToolDef<TArgs> {
  name: string
  description: string
  // JSON Schema for the inputSchema field in the MCP tools/list response.
  inputSchema: Record<string, unknown>
  // Zod schema for runtime argument validation.
  zodSchema: z.ZodType<TArgs>
  run(args: TArgs, ctx: ToolCtx): Promise<unknown>
}

export interface ToolCtx {
  actor: string
  lists: ListsClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools: ToolDef<any>[] = [
  // ---- list_lists -------------------------------------------------------
  {
    name: 'list_lists',
    description:
      "List all of the user's task lists across all their list groups.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    zodSchema: z.object({}),
    async run(_args: Record<string, never>, ctx: ToolCtx) {
      // RPL<->RPP separation (#675): Planner-managed groups (shopping/
      // notes/diary live there) are Planner's surface — agents must not
      // see or edit them. Filtered HERE, not in the lists-api RPC core:
      // planner-api resolves its personal scope through the same RPC, so
      // a core-level filter breaks Planner itself.
      const groups = (await ctx.lists.listGroups(ctx.actor)).filter(
        (g) => g.origin !== 'planner',
      )
      const allLists = await Promise.all(
        groups.map((g) =>
          ctx.lists.listLists({ scopeType: 'list_group', scopeId: g.id }, ctx.actor),
        ),
      )
      return allLists.flat()
    },
  },

  // ---- get_list ---------------------------------------------------------
  {
    name: 'get_list',
    description:
      'Get all statuses and items for a specific list by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list (e.g. lst_…).' },
      },
      required: ['listId'],
    },
    zodSchema: z.object({ listId: z.string().min(1) }),
    async run(args: { listId: string }, ctx: ToolCtx) {
      const [statuses, items] = await Promise.all([
        ctx.lists.listStatuses(args.listId, ctx.actor),
        ctx.lists.listItems(args.listId, ctx.actor),
      ])
      return { statuses, items }
    },
  },

  // ---- list_items -------------------------------------------------------
  {
    name: 'list_items',
    description: 'List all items in a specific list.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list (e.g. lst_…).' },
      },
      required: ['listId'],
    },
    zodSchema: z.object({ listId: z.string().min(1) }),
    async run(args: { listId: string }, ctx: ToolCtx) {
      return ctx.lists.listItems(args.listId, ctx.actor)
    },
  },

  // ---- get_item ---------------------------------------------------------
  {
    name: 'get_item',
    description:
      'Get a single list item with its comments.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list.' },
        itemId: { type: 'string', description: 'The ID of the item (e.g. lit_…).' },
      },
      required: ['listId', 'itemId'],
    },
    zodSchema: z.object({ listId: z.string().min(1), itemId: z.string().min(1) }),
    async run(args: { listId: string; itemId: string }, ctx: ToolCtx) {
      const item = await ctx.lists.getItem(args.listId, args.itemId, ctx.actor)
      if (!item) {
        throw new Error(`Item ${args.itemId} not found in list ${args.listId}`)
      }
      const comments = await ctx.lists.listComments(args.listId, args.itemId, ctx.actor)
      return { ...item, comments }
    },
  },

  // ---- create_item ------------------------------------------------------
  {
    name: 'create_item',
    description: 'Create a new item in a list.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list.' },
        title: { type: 'string', description: 'Item title.' },
        notes: { type: 'string', description: 'Optional notes / description.' },
        statusId: { type: 'string', description: 'Optional custom status ID (lst_…).' },
        assignedTo: { type: 'string', description: 'Optional user ID to assign the item to.' },
        parentId: { type: 'string', description: 'Optional parent item ID for sub-items.' },
        dueDate: { type: 'string', description: 'Optional ISO-8601 due date string.' },
      },
      required: ['listId', 'title'],
    },
    zodSchema: z.object({
      listId: z.string().min(1),
      title: z.string().min(1),
      notes: z.string().optional(),
      statusId: z.string().optional(),
      assignedTo: z.string().optional(),
      parentId: z.string().optional(),
      dueDate: z.string().optional(),
    }),
    async run(
      args: {
        listId: string
        title: string
        notes?: string
        statusId?: string
        assignedTo?: string
        parentId?: string
        dueDate?: string
      },
      ctx: ToolCtx,
    ) {
      const { listId, ...input } = args
      // Cast to CreateListItemInput — the api will apply defaults (e.g.
      // priority = 'medium') so we don't need to supply them here.
      return ctx.lists.createListItem(listId, input as CreateListItemInput, ctx.actor)
    },
  },

  // ---- update_item ------------------------------------------------------
  {
    name: 'update_item',
    description: 'Update fields on an existing list item.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list.' },
        itemId: { type: 'string', description: 'The ID of the item.' },
        title: { type: 'string', description: 'New title.' },
        notes: { type: 'string', description: 'New notes.' },
        statusId: { type: 'string', description: 'New custom status ID.' },
        completed: { type: 'boolean', description: 'Mark the item completed/incomplete.' },
        assignedTo: { type: 'string', description: 'New assignee user ID.' },
        parentId: { type: 'string', description: 'New parent item ID (null to unparent).' },
      },
      required: ['listId', 'itemId'],
    },
    zodSchema: z.object({
      listId: z.string().min(1),
      itemId: z.string().min(1),
      title: z.string().optional(),
      notes: z.string().optional(),
      statusId: z.string().optional(),
      completed: z.boolean().optional(),
      assignedTo: z.string().optional(),
      parentId: z.string().optional(),
    }),
    async run(
      args: {
        listId: string
        itemId: string
        title?: string
        notes?: string
        statusId?: string
        completed?: boolean
        assignedTo?: string
        parentId?: string
      },
      ctx: ToolCtx,
    ) {
      const { listId, itemId, ...patch } = args
      return ctx.lists.updateListItem(listId, itemId, patch as UpdateListItemInput, ctx.actor)
    },
  },

  // ---- complete_item ----------------------------------------------------
  {
    name: 'complete_item',
    description: 'Mark a list item as completed.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list.' },
        itemId: { type: 'string', description: 'The ID of the item to complete.' },
      },
      required: ['listId', 'itemId'],
    },
    zodSchema: z.object({ listId: z.string().min(1), itemId: z.string().min(1) }),
    async run(args: { listId: string; itemId: string }, ctx: ToolCtx) {
      // Dual-write invariant: `completed` and the custom-status id must
      // agree (see update_item's statusId handling and
      // packages/lists-shared/statuses.ts). A list with custom statuses
      // (RPL v1.0.0 slice 1) has a `done`-category status that is the
      // real source of truth for "done" in the UI's board/kanban view —
      // setting only `completed` would leave the item parked on its old
      // status while showing as complete. Resolve the list's terminal
      // status and set both; a list with no custom statuses (empty
      // array — statuses aren't lazily seeded by this read-only lookup)
      // keeps the previous completed-only behavior.
      const statuses = await ctx.lists.listStatuses(args.listId, ctx.actor)
      const done = firstDoneStatus(statuses)
      const patch: UpdateListItemInput = done
        ? { completed: true, statusId: done.id }
        : { completed: true }
      return ctx.lists.updateListItem(args.listId, args.itemId, patch, ctx.actor)
    },
  },

  // ---- add_comment ------------------------------------------------------
  {
    name: 'add_comment',
    description: 'Add a comment to a list item.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The ID of the list.' },
        itemId: { type: 'string', description: 'The ID of the item.' },
        body: { type: 'string', description: 'The comment text.' },
      },
      required: ['listId', 'itemId', 'body'],
    },
    zodSchema: z.object({
      listId: z.string().min(1),
      itemId: z.string().min(1),
      body: z.string().min(1),
    }),
    async run(args: { listId: string; itemId: string; body: string }, ctx: ToolCtx) {
      return ctx.lists.createComment(args.listId, args.itemId, { body: args.body }, ctx.actor)
    },
  },
]

export default tools

// Map by name for O(1) lookup in handleMcpMessage.
export const toolsByName: Map<string, ToolDef<unknown>> = new Map(
  tools.map((t) => [t.name, t]),
)
