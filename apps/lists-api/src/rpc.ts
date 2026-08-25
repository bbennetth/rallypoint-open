/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { CreateListItemSeriesInput, UpdateListItemSeriesInput } from './repos/types.js'
import { ensureDeps, type WorkerEnv } from './worker.js'
import {
  createCommentCore,
  createFieldDefCore,
  createGroupCore,
  createListCore,
  createListItemCore,
  createSeriesCore,
  deleteFieldDefCore,
  deleteListCore,
  deleteListItemCore,
  deleteSeriesCore,
  findItemInScopeCore,
  mergeListsCore,
  getItemCore,
  listCommentsCore,
  listDeletedItemsCore,
  listFieldDefsCore,
  listGroupsCore,
  listItemsCore,
  listItemsPageCore,
  listLabelsCore,
  listListsCore,
  listSeriesCore,
  listStatusesCore,
  moveListItemCore,
  resolveMcpTokenCore,
  restoreListItemCore,
  updateFieldDefCore,
  updateListItemCore,
  updateSeriesCore,
  type CommentDto,
  type DeletedListItemDto,
  type CreateFieldDefInputCore,
  type CreateGroupInput,
  type CreateListInputCore,
  type CreateListItemInputCore,
  type FieldDefDto,
  type FieldNotFound,
  type GroupDto,
  type ItemNotFound,
  type ItemNotDeleted,
  type ItemPurgeWindowElapsed,
  type LabelDto,
  type ListDto,
  type ListItemDto,
  type ListItemsPage,
  type ListStatusDto,
  type ListsNotFound,
  type ListsRpcDeps,
  type MergeListsResult,
  type NameConflict,
  type Ok,
  type ResolvedMcpToken,
  type SameSourceTarget,
  type SeriesDto,
  type SeriesNotFound,
  type SeriesOccurrenceImmovable,
  type SystemManaged,
  type Unauthorized,
  type Forbidden,
  type UpdateFieldDefInputCore,
  type UpdateListItemInputCore,
} from './services/rpc-core.js'
import {
  exportListBundleCore,
  importListBundleCore,
  type ImportScope,
} from './services/rpc-transfer.js'
import type { ListBundle, ListImportResult } from '@rallypoint/lists-shared'

// Cross-Worker RPC entrypoint for lists-api (PR 1 of feat/rpc-bindings).
//
// Consumers (events-api, planner-api, lists-mcp) bind:
//   [[services]]
//   binding = "LISTS"
//   service = "rallypoint-lists"
//   entrypoint = "ListsRPC"
// and call `env.LISTS.method(...)` directly. The methods delegate to the
// *Core fns in services/rpc-core.ts. The legacy HTTP routes under
// routes/sdk-*.ts continue to use their inline logic until PR 3 deletes
// them; both surfaces share the `_move.ts` helpers, the
// `@rallypoint/lists-shared` rules, and the same repos, so behavior
// stays in sync.

export class ListsRPC extends WorkerEntrypoint<WorkerEnv> {
  // --- Read surface --------------------------------------------------

  async listLists(
    actor: string,
    scopeType: 'group' | 'list_group',
    scopeId: string,
  ): Promise<ListDto[]> {
    return listListsCore(actor, scopeType, scopeId, this.deps)
  }
  async listItems(actor: string, listId: string): Promise<Ok<ListItemDto[]> | ListsNotFound> {
    return listItemsCore(actor, listId, this.deps)
  }
  // Keyset-paged sibling of listItems (default order). Prefer this for large
  // lists; listItems returns the whole set and is kept for existing callers.
  async listItemsPage(
    actor: string,
    listId: string,
    page?: { limit?: number; cursor?: string | null },
  ): Promise<Ok<ListItemsPage> | ListsNotFound> {
    return listItemsPageCore(actor, listId, page ?? {}, this.deps)
  }
  async listDeletedItems(
    actor: string,
    listId: string,
  ): Promise<Ok<DeletedListItemDto[]> | ListsNotFound> {
    return listDeletedItemsCore(actor, listId, this.deps)
  }
  async getItem(
    actor: string,
    listId: string,
    itemId: string,
  ): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound> {
    return getItemCore(actor, listId, itemId, this.deps)
  }
  async listFieldDefs(actor: string, listId: string): Promise<Ok<FieldDefDto[]> | ListsNotFound> {
    return listFieldDefsCore(actor, listId, this.deps)
  }
  async listStatuses(actor: string, listId: string): Promise<Ok<ListStatusDto[]> | ListsNotFound> {
    return listStatusesCore(actor, listId, this.deps)
  }
  async listLabels(actor: string, listId: string): Promise<Ok<LabelDto[]> | ListsNotFound> {
    return listLabelsCore(actor, listId, this.deps)
  }
  async listComments(
    actor: string,
    listId: string,
    itemId: string,
  ): Promise<Ok<CommentDto[]> | ListsNotFound | ItemNotFound> {
    return listCommentsCore(actor, listId, itemId, this.deps)
  }

  // --- Write surface -------------------------------------------------

  async listGroups(actor: string): Promise<GroupDto[]> {
    return listGroupsCore(actor, this.deps)
  }
  async createGroup(actor: string, input: CreateGroupInput): Promise<GroupDto> {
    return createGroupCore(actor, input, this.deps)
  }
  async createList(actor: string, input: CreateListInputCore): Promise<Ok<ListDto> | ListsNotFound | NameConflict> {
    return createListCore(actor, input, this.deps)
  }
  async deleteList(actor: string, listId: string): Promise<Ok<true> | ListsNotFound | Forbidden | SystemManaged> {
    return deleteListCore(actor, listId, this.deps)
  }
  async createListItem(
    actor: string,
    listId: string,
    input: CreateListItemInputCore,
  ): Promise<Ok<ListItemDto> | ListsNotFound> {
    return createListItemCore(actor, listId, input, this.deps)
  }
  async updateListItem(
    actor: string,
    listId: string,
    itemId: string,
    patch: UpdateListItemInputCore,
  ): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound> {
    return updateListItemCore(actor, listId, itemId, patch, this.deps)
  }
  async deleteListItem(
    actor: string,
    listId: string,
    itemId: string,
  ): Promise<Ok<true> | ListsNotFound | ItemNotFound> {
    return deleteListItemCore(actor, listId, itemId, this.deps)
  }
  async restoreListItem(
    actor: string,
    listId: string,
    itemId: string,
  ): Promise<
    Ok<ListItemDto> | ListsNotFound | ItemNotFound | ItemNotDeleted | ItemPurgeWindowElapsed
  > {
    return restoreListItemCore(actor, listId, itemId, this.deps)
  }
  async moveListItem(
    actor: string,
    listId: string,
    itemId: string,
    targetListId: string,
  ): Promise<
    Ok<ListItemDto> | ListsNotFound | ItemNotFound | SameSourceTarget | SeriesOccurrenceImmovable
  > {
    return moveListItemCore(actor, listId, itemId, targetListId, this.deps)
  }
  async findItemInScope(
    actor: string,
    scopeType: string,
    scopeId: string,
    itemId: string,
  ): Promise<Ok<ListItemDto> | ItemNotFound | ListsNotFound> {
    return findItemInScopeCore(actor, scopeType, scopeId, itemId, this.deps)
  }
  async mergeLists(
    actor: string,
    targetListId: string,
    sourceListIds: string[],
  ): Promise<Ok<MergeListsResult> | ListsNotFound | SameSourceTarget | Forbidden> {
    return mergeListsCore(actor, targetListId, sourceListIds, this.deps)
  }
  // --- data transfer (backup–restore) --------------------------------
  // Generic per-list export/import. Planner's backup feature composes these;
  // the shape of a list and the rules for writing one back stay here.
  async exportListBundle(actor: string, listId: string): Promise<Ok<ListBundle> | ListsNotFound> {
    return exportListBundleCore(actor, listId, this.deps)
  }
  async importListBundle(
    actor: string,
    scope: ImportScope,
    bundle: ListBundle,
  ): Promise<Ok<ListImportResult> | ListsNotFound | Forbidden> {
    return importListBundleCore(actor, scope, bundle, this.deps)
  }
  async createFieldDef(
    actor: string,
    listId: string,
    input: CreateFieldDefInputCore,
  ): Promise<Ok<FieldDefDto> | ListsNotFound | Forbidden> {
    return createFieldDefCore(actor, listId, input, this.deps)
  }
  async updateFieldDef(
    actor: string,
    listId: string,
    fieldId: string,
    patch: UpdateFieldDefInputCore,
  ): Promise<Ok<FieldDefDto> | ListsNotFound | Forbidden | FieldNotFound> {
    return updateFieldDefCore(actor, listId, fieldId, patch, this.deps)
  }
  async deleteFieldDef(
    actor: string,
    listId: string,
    fieldId: string,
  ): Promise<Ok<true> | ListsNotFound | Forbidden | FieldNotFound> {
    return deleteFieldDefCore(actor, listId, fieldId, this.deps)
  }
  async createComment(
    actor: string,
    listId: string,
    itemId: string,
    body: string,
  ): Promise<Ok<CommentDto> | ListsNotFound | ItemNotFound> {
    return createCommentCore(actor, listId, itemId, body, this.deps)
  }

  // --- Series --------------------------------------------------------

  async createSeries(
    actor: string,
    listId: string,
    input: CreateListItemSeriesInput,
  ): Promise<Ok<SeriesDto> | ListsNotFound | Forbidden> {
    return createSeriesCore(actor, listId, input, this.deps)
  }
  async listSeries(actor: string, listId: string): Promise<Ok<SeriesDto[]> | ListsNotFound> {
    return listSeriesCore(actor, listId, this.deps)
  }
  async updateSeries(
    actor: string,
    seriesId: string,
    input: UpdateListItemSeriesInput,
  ): Promise<Ok<SeriesDto> | SeriesNotFound | Forbidden> {
    return updateSeriesCore(actor, seriesId, input, this.deps)
  }
  async deleteSeries(
    actor: string,
    seriesId: string,
  ): Promise<Ok<true> | SeriesNotFound | Forbidden> {
    return deleteSeriesCore(actor, seriesId, this.deps)
  }

  // --- MCP -----------------------------------------------------------

  async resolveMcpToken(token: string): Promise<Ok<ResolvedMcpToken> | Unauthorized> {
    return resolveMcpTokenCore(token, this.deps)
  }

  // --- Internals -----------------------------------------------------

  private get deps(): ListsRpcDeps {
    const d = ensureDeps(this.env)
    return { env: d.env, logger: d.logger, repos: d.repos }
  }
}
