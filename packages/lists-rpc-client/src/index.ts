/// <reference types="@cloudflare/workers-types" />
import type { Service } from '@cloudflare/workers-types'
import type { ListsRPC } from '@rallypoint/lists-api'
import type {
  ListsClient,
  DeletedListItemDto,
  ListItemsPage,
  ListDto,
  ListItemDto,
  FieldDefDto,
  ListStatusDto,
  LabelDto,
  CreateFieldDefInput,
  UpdateFieldDefInput,
  GroupDto,
  SdkCreateGroupInput,
  CreateListInput,
  CreateListItemInput,
  UpdateListItemInput,
  ListItemSeriesDto,
  CreateSeriesInput,
  UpdateSeriesInput,
  CommentDto,
  MergeListsResult,
} from '@rallypoint/lists-client'
import type { ListBundle, ListImportResult, ScopeType } from '@rallypoint/lists-shared'
import { ListsClientError } from '@rallypoint/lists-client'

// The single canonical `Service<ListsRPC>` → `ListsClient` adapter,
// unified (R3) from what used to be two byte-for-byte-identical copies
// (`apps/planner-api/src/services/lists-client-rpc.ts` and
// `apps/lists-mcp/src/lists-client-rpc.ts`). Implements the existing
// `ListsClient` interface (preserves call-site shape) but dispatches
// each method to the binding's RPC method. The argument order on the
// producer is `actor, ...params` whereas the SDK shape was
// `...params, actor` — the adapter normalises both. Discriminated
// returns from the producer are unwrapped to either the data or a
// `ListsClientError` matching the SDK's existing error class.
//
// NOTE: `apps/events-api/src/services/lists-client.ts` is deliberately
// decoupled from this and is NOT unified here.

type RpcReturn<T extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<T>>

function notFound(message: string): ListsClientError {
  return new ListsClientError(404, 'not_found', message)
}

function unwrap<T>(
  result:
    | { kind: 'ok'; data: T }
    | { kind: 'list_not_found' }
    | { kind: 'item_not_found' }
    | { kind: 'item_not_deleted' }
    | { kind: 'item_purge_window_elapsed' }
    | { kind: 'field_not_found' }
    | { kind: 'series_not_found' }
    | { kind: 'system_managed_list' }
    | { kind: 'list_name_conflict' }
    | { kind: 'same_source_target' }
    | { kind: 'series_occurrence_immovable' }
    | { kind: 'unauthorized' }
    | { kind: 'forbidden' },
): T {
  if (result.kind === 'ok') return result.data
  if (result.kind === 'list_not_found') throw notFound('List not found.')
  if (result.kind === 'item_not_found') throw notFound('Item not found.')
  if (result.kind === 'item_not_deleted') {
    throw new ListsClientError(409, 'item_not_deleted', 'Item is not deleted.')
  }
  if (result.kind === 'item_purge_window_elapsed') {
    throw new ListsClientError(409, 'item_purge_window_elapsed', 'Restore window has elapsed.')
  }
  if (result.kind === 'field_not_found') throw notFound('Field not found.')
  if (result.kind === 'series_not_found') throw notFound('Series not found.')
  if (result.kind === 'list_name_conflict') {
    throw new ListsClientError(409, 'list_name_conflict', 'A list with that name already exists.')
  }
  if (result.kind === 'system_managed_list') {
    throw new ListsClientError(
      409,
      'system_managed_list',
      'System-managed lists cannot be deleted.',
    )
  }
  if (result.kind === 'same_source_target') {
    throw new ListsClientError(
      422,
      'same_source_target',
      'Target list must differ from the source list.',
    )
  }
  if (result.kind === 'series_occurrence_immovable') {
    throw new ListsClientError(
      422,
      'series_occurrence_immovable',
      'A recurring-series occurrence cannot be moved on its own.',
    )
  }
  if (result.kind === 'forbidden') {
    throw new ListsClientError(403, 'forbidden', 'Only the list creator can do that.')
  }
  throw new ListsClientError(401, 'unauthorized', 'Unauthorized.')
}

export function createListsClientFromBinding(binding: Service<ListsRPC>): ListsClient {
  return {
    async health() {
      return { status: 'rpc' }
    },
    async listLists(
      scope: { scopeType: ScopeType; scopeId: string },
      actor: string,
    ): Promise<ListDto[]> {
      const rows = (await binding.listLists(actor, scope.scopeType, scope.scopeId)) as RpcReturn<
        ListsRPC['listLists']
      >
      return rows as unknown as ListDto[]
    },
    async listItems(listId: string, actor: string): Promise<ListItemDto[]> {
      const r = (await binding.listItems(actor, listId)) as RpcReturn<ListsRPC['listItems']>
      return unwrap(r) as unknown as ListItemDto[]
    },
    async listItemsPage(
      listId: string,
      actor: string,
      page?: { limit?: number; cursor?: string | null },
    ): Promise<ListItemsPage> {
      const r = (await binding.listItemsPage(actor, listId, page)) as RpcReturn<
        ListsRPC['listItemsPage']
      >
      return unwrap(r) as unknown as ListItemsPage
    },
    async listDeletedItems(listId: string, actor: string): Promise<DeletedListItemDto[]> {
      const r = (await binding.listDeletedItems(actor, listId)) as RpcReturn<
        ListsRPC['listDeletedItems']
      >
      return unwrap(r) as unknown as DeletedListItemDto[]
    },
    async getItem(listId: string, itemId: string, actor: string): Promise<ListItemDto | null> {
      const r = (await binding.getItem(actor, listId, itemId)) as RpcReturn<ListsRPC['getItem']>
      if (r.kind === 'item_not_found' || r.kind === 'list_not_found') return null
      return unwrap(r) as unknown as ListItemDto
    },
    async listFieldDefs(listId: string, actor: string): Promise<FieldDefDto[]> {
      const r = (await binding.listFieldDefs(actor, listId)) as RpcReturn<ListsRPC['listFieldDefs']>
      return unwrap(r) as unknown as FieldDefDto[]
    },
    async listStatuses(listId: string, actor: string): Promise<ListStatusDto[]> {
      const r = (await binding.listStatuses(actor, listId)) as RpcReturn<ListsRPC['listStatuses']>
      return unwrap(r) as unknown as ListStatusDto[]
    },
    async listLabels(listId: string, actor: string): Promise<LabelDto[]> {
      const r = (await binding.listLabels(actor, listId)) as RpcReturn<ListsRPC['listLabels']>
      return unwrap(r) as unknown as LabelDto[]
    },
    async createFieldDef(
      listId: string,
      input: CreateFieldDefInput,
      actor: string,
    ): Promise<FieldDefDto> {
      const r = (await binding.createFieldDef(actor, listId, input as never)) as RpcReturn<
        ListsRPC['createFieldDef']
      >
      return unwrap(r) as unknown as FieldDefDto
    },
    async updateFieldDef(
      listId: string,
      fieldId: string,
      patch: UpdateFieldDefInput,
      actor: string,
    ): Promise<FieldDefDto> {
      const r = (await binding.updateFieldDef(actor, listId, fieldId, patch as never)) as RpcReturn<
        ListsRPC['updateFieldDef']
      >
      return unwrap(r) as unknown as FieldDefDto
    },
    async deleteFieldDef(listId: string, fieldId: string, actor: string): Promise<void> {
      const r = (await binding.deleteFieldDef(actor, listId, fieldId)) as RpcReturn<
        ListsRPC['deleteFieldDef']
      >
      unwrap(r)
    },
    async listGroups(actor: string): Promise<GroupDto[]> {
      const r = (await binding.listGroups(actor)) as RpcReturn<ListsRPC['listGroups']>
      return r as unknown as GroupDto[]
    },
    async createGroup(input: SdkCreateGroupInput, actor: string): Promise<GroupDto> {
      const g = (await binding.createGroup(actor, input as never)) as RpcReturn<
        ListsRPC['createGroup']
      >
      return g as unknown as GroupDto
    },
    async createList(input: CreateListInput, actor: string): Promise<ListDto> {
      const r = (await binding.createList(actor, input as never)) as RpcReturn<
        ListsRPC['createList']
      >
      return unwrap(r) as unknown as ListDto
    },
    async deleteList(listId: string, actor: string): Promise<void> {
      const r = (await binding.deleteList(actor, listId)) as RpcReturn<ListsRPC['deleteList']>
      unwrap(r)
    },
    async createListItem(
      listId: string,
      input: CreateListItemInput,
      actor: string,
    ): Promise<ListItemDto> {
      const r = (await binding.createListItem(actor, listId, input as never)) as RpcReturn<
        ListsRPC['createListItem']
      >
      return unwrap(r) as unknown as ListItemDto
    },
    async updateListItem(
      listId: string,
      itemId: string,
      patch: UpdateListItemInput,
      actor: string,
    ): Promise<ListItemDto> {
      const r = (await binding.updateListItem(
        actor,
        listId,
        itemId,
        patch as never,
      )) as RpcReturn<ListsRPC['updateListItem']>
      return unwrap(r) as unknown as ListItemDto
    },
    async deleteListItem(listId: string, itemId: string, actor: string): Promise<void> {
      const r = (await binding.deleteListItem(actor, listId, itemId)) as RpcReturn<
        ListsRPC['deleteListItem']
      >
      unwrap(r)
    },
    async restoreListItem(
      listId: string,
      itemId: string,
      actor: string,
    ): Promise<ListItemDto> {
      const r = (await binding.restoreListItem(actor, listId, itemId)) as RpcReturn<
        ListsRPC['restoreListItem']
      >
      return unwrap(r) as unknown as ListItemDto
    },
    async moveListItem(
      listId: string,
      itemId: string,
      targetListId: string,
      actor: string,
    ): Promise<ListItemDto> {
      const r = (await binding.moveListItem(actor, listId, itemId, targetListId)) as RpcReturn<
        ListsRPC['moveListItem']
      >
      return unwrap(r) as unknown as ListItemDto
    },
    async findItemInScope(
      scope: { scopeType: ScopeType; scopeId: string },
      itemId: string,
      actor: string,
    ): Promise<ListItemDto | null> {
      const r = (await binding.findItemInScope(
        actor,
        scope.scopeType,
        scope.scopeId,
        itemId,
      )) as RpcReturn<ListsRPC['findItemInScope']>
      if (r.kind === 'item_not_found' || r.kind === 'list_not_found') return null
      return unwrap(r) as unknown as ListItemDto
    },
    async createListItemSeries(
      listId: string,
      input: CreateSeriesInput,
      actor: string,
    ): Promise<ListItemSeriesDto> {
      const r = (await binding.createSeries(actor, listId, input as never)) as RpcReturn<
        ListsRPC['createSeries']
      >
      return unwrap(r) as unknown as ListItemSeriesDto
    },
    async listSeries(listId: string, actor: string): Promise<ListItemSeriesDto[]> {
      const r = (await binding.listSeries(actor, listId)) as RpcReturn<ListsRPC['listSeries']>
      return unwrap(r) as unknown as ListItemSeriesDto[]
    },
    async updateSeries(
      seriesId: string,
      patch: UpdateSeriesInput,
      actor: string,
    ): Promise<ListItemSeriesDto> {
      const r = (await binding.updateSeries(actor, seriesId, patch as never)) as RpcReturn<
        ListsRPC['updateSeries']
      >
      return unwrap(r) as unknown as ListItemSeriesDto
    },
    async deleteSeries(seriesId: string, actor: string): Promise<void> {
      const r = (await binding.deleteSeries(actor, seriesId)) as RpcReturn<ListsRPC['deleteSeries']>
      unwrap(r)
    },
    async listComments(listId: string, itemId: string, actor: string): Promise<CommentDto[]> {
      const r = (await binding.listComments(actor, listId, itemId)) as RpcReturn<
        ListsRPC['listComments']
      >
      return unwrap(r) as unknown as CommentDto[]
    },
    async createComment(
      listId: string,
      itemId: string,
      input: { body: string },
      actor: string,
    ): Promise<CommentDto> {
      const r = (await binding.createComment(actor, listId, itemId, input.body)) as RpcReturn<
        ListsRPC['createComment']
      >
      return unwrap(r) as unknown as CommentDto
    },
    async exportListBundle(listId: string, actor: string): Promise<ListBundle> {
      const r = (await binding.exportListBundle(actor, listId)) as RpcReturn<
        ListsRPC['exportListBundle']
      >
      return unwrap(r) as unknown as ListBundle
    },
    async importListBundle(
      scope: { scopeType: ScopeType; scopeId: string },
      bundle: ListBundle,
      actor: string,
    ): Promise<ListImportResult> {
      const r = (await binding.importListBundle(actor, scope, bundle)) as RpcReturn<
        ListsRPC['importListBundle']
      >
      return unwrap(r) as unknown as ListImportResult
    },
    async mergeLists(
      targetListId: string,
      sourceListIds: string[],
      actor: string,
    ): Promise<MergeListsResult> {
      const r = (await binding.mergeLists(actor, targetListId, sourceListIds)) as RpcReturn<
        ListsRPC['mergeLists']
      >
      return unwrap(r) as unknown as MergeListsResult
    },
  }
}
