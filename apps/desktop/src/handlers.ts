import { RECAP_INSTRUCTIONS } from '@loam/agent'
import {
  JOURNAL_KIT,
  addPracticeImages,
  localDate,
  type SuggestionService,
  type BibleService,
  type Clock,
  type ReferenceService,
} from '@loam/core'
import type { Handlers, ResponseOf } from '@loam/protocol'
import type { AiController } from './ai/controller.ts'

export interface HandlerDeps {
  clock: Clock
  references: ReferenceService
  bible: BibleService
  /** The study journal: the same vault service, opening Journal-kit vaults only. */
  journal: BibleService
  /** Where a new journal is suggested: Documents/Loam Journal. */
  suggestedJournalFolder: string
  /** What the About dialog shows. */
  about: () => ResponseOf<'app:about'>
  /** The text of THIRD_PARTY_NOTICES.md as shipped with the app. */
  notices: () => string
  /** Shows the system folder picker; null when cancelled. */
  pickFolder: (purpose: 'create' | 'open' | 'sample') => Promise<string | null>
  /** Copies the bundled sample bible into <folder>/bible; returns that path. */
  copySample: (folder: string) => string
  /** Opens an http(s) URL in the system browser. */
  openExternal: (url: string) => Promise<boolean>
  /** Tag suggestions: accept and reject. */
  suggestions: SuggestionService
  /** The local AI helpers (off by default). */
  ai: AiController
}

/** Backend handlers for every protocol message; each maps to one core use case. */
export function createHandlers({
  clock,
  references,
  bible,
  journal,
  suggestedJournalFolder,
  about,
  notices,
  pickFolder,
  copySample,
  openExternal,
  suggestions,
  ai,
}: HandlerDeps): Handlers {
  /** The service that has this vault open: the journal's, or else the bible's. */
  const vaults = (vaultId: number): BibleService => (journal.owns(vaultId) ? journal : bible)
  return {
    'app:ping': (request) => ({
      reply: `pong: ${request.message}`,
      receivedAt: clock.now().toISOString(),
    }),
    'app:about': () => about(),
    'app:notices': () => ({ text: notices() }),
    'refs:listBoard': (request) => references.listBoard(request),
    'refs:getDetail': (request) => ({
      detail: references.getDetail(request.id),
      suggestions: suggestions.list(request.id),
    }),
    'refs:import': async (request) => {
      const results = await references.importImages(request.items, request.boardId, request.at)
      // New images may need suggestions; the queue only runs while AI is on.
      ai.wake()
      return { results }
    },
    'refs:acceptSuggestions': (request) => ({
      detail: suggestions.accept(request.id, request.tags),
      suggestions: suggestions.list(request.id),
    }),
    'refs:rejectSuggestion': (request) => {
      suggestions.reject(request.id, request.tag)
      return { suggestions: suggestions.list(request.id) }
    },
    'ai:status': () => ai.status(),
    'ai:setEnabled': (request) => ai.setEnabled(request.enabled),
    'ai:setPauseApps': (request) => ai.setPauseApps(request.apps),
    'ai:setPaused': (request) => ai.setPaused(request.paused),
    'ai:download': () => ai.download(),
    'ai:cancelDownload': () => ai.cancelDownload(),
    'ai:deleteModel': () => ai.deleteModel(),
    'journal:recap': async (request) => {
      const sources = journal.recapSources(request.vaultId, request.scope)
      if (sources.length === 0) {
        throw new Error(
          request.scope.kind === 'week'
            ? 'No session notes from this week to recap yet'
            : 'No session notes for this topic to recap yet',
        )
      }
      const texts = sources.map(
        (source) => `## ${source.title}${source.date ? ` (${source.date})` : ''}
${source.text}`,
      )
      const draft = await ai.summarize(texts, RECAP_INSTRUCTIONS)
      const today = localDate(clock.now())
      const topic =
        request.scope.kind === 'topic'
          ? journal.getEntry(request.vaultId, request.scope.path).title
          : null
      return {
        draft,
        title: topic ? `${today} Recap: ${topic}` : `${today} Weekly recap`,
        sources: sources.map(({ id, path, title, date }) => ({ id, path, title, date })),
      }
    },
    'journal:saveRecap': (request) =>
      journal.saveRecap(request.vaultId, request.title, request.text, request.sourceIds),
    'refs:update': (request) => {
      const { id, ...patch } = request
      return { detail: references.update(id, patch) }
    },
    'boards:create': (request) => ({ board: references.createBoard(request.name) }),
    'refs:delete': (request) => ({ ids: references.moveToTrash(request.ids) }),
    'refs:restore': (request) => ({ ids: references.restoreFromTrash(request.ids) }),
    'trash:empty': () => references.emptyTrash(),
    'boards:removeRefs': (request) => {
      const { removed, undo } = references.removeFromBoard(request.boardId, request.ids)
      return { ids: removed, undo }
    },
    'boards:addRefs': (request) => ({
      ids: references.addToBoard(request.boardId, request.ids, request.at),
    }),
    'boards:setViewMode': (request) => ({
      mode: references.setViewMode(request.boardId, request.mode),
    }),
    'canvas:get': (request) => references.getCanvas(request.boardId),
    'canvas:apply': (request) => references.applyCanvas(request.boardId, request.ops),
    'bible:home': async () => {
      const { current, problem } = await bible.home()
      const kits = bible.kits().map(({ id, name, description, sections }) => ({
        id,
        name,
        description,
        sections: sections.map((section) => ({ id: section.id, name: section.name })),
      }))
      return { current, recent: bible.recent(), kits, problem }
    },
    'bible:pickFolder': async (request) => ({ path: await pickFolder(request.purpose) }),
    'bible:create': (request) => bible.create(request.folder, request.kitId, request.title),
    'bible:open': (request) => bible.open(request.path),
    'bible:openSample': (request) => bible.open(copySample(request.folder)),
    'bible:view': (request) => vaults(request.vaultId).view(request.vaultId),
    'bible:entry': (request) => vaults(request.vaultId).getEntry(request.vaultId, request.path),
    'bible:createEntry': (request) => {
      const service = vaults(request.vaultId)
      if (request.linkFrom) {
        return service.createLinkedEntry(
          request.vaultId,
          request.linkFrom,
          request.section,
          request.title,
        )
      }
      return service.createEntry(
        request.vaultId,
        request.section,
        request.title,
        request.body,
        request.intro ?? null,
      )
    },
    'bible:setProperties': (request) =>
      vaults(request.vaultId).setProperties(
        request.vaultId,
        request.path,
        request.changes,
        request.baseVersion,
      ),
    'bible:tagOptions': (request) => {
      const tags = [...vaults(request.vaultId).vaultTags(request.vaultId)]
      const seen = new Set(tags.map((tag) => tag.toLowerCase()))
      for (const tag of references.tagNames()) {
        if (!seen.has(tag.toLowerCase())) tags.push(tag)
      }
      return { tags }
    },
    'bible:duplicateEntry': (request) =>
      vaults(request.vaultId).duplicateEntry(request.vaultId, request.path),
    'bible:moveEntry': (request) =>
      vaults(request.vaultId).moveEntry(request.vaultId, request.path, request.section),
    'bible:reorderEntries': (request) =>
      vaults(request.vaultId).reorderEntries(
        request.vaultId,
        request.section,
        request.paths,
        request.moved,
      ),
    'bible:trash': (request) => ({ items: vaults(request.vaultId).listTrash(request.vaultId) }),
    'bible:restoreTrash': (request) =>
      vaults(request.vaultId).restoreFromTrash(request.vaultId, request.trashPath),
    'bible:purgeTrash': async (request) => ({
      items: await vaults(request.vaultId).purgeFromTrash(request.vaultId, request.trashPath),
    }),
    'bible:pillars': (request) => ({ cards: vaults(request.vaultId).pillars(request.vaultId) }),
    'bible:setSectionFields': (request) =>
      vaults(request.vaultId).setSectionFields(request.vaultId, request.sectionId, request.fields),
    'bible:swapTemplate': (request) =>
      vaults(request.vaultId).swapTemplate(
        request.vaultId,
        request.path,
        request.fromSection,
        request.baseVersion,
      ),
    'bible:timeline': (request) => ({ items: vaults(request.vaultId).timeline(request.vaultId) }),
    'bible:ideas': (request) => ({ cards: vaults(request.vaultId).ideas(request.vaultId) }),
    'bible:review': (request) => ({ items: vaults(request.vaultId).review(request.vaultId) }),
    'bible:promote': (request) =>
      vaults(request.vaultId).promoteIdea(
        request.vaultId,
        request.path,
        request.section,
        request.title,
      ),
    'bible:undoPromote': (request) =>
      vaults(request.vaultId).undoPromote(request.vaultId, request.undo),
    'bible:addReferences': (request) =>
      vaults(request.vaultId).addReferences(
        request.vaultId,
        request.path,
        request.referenceIds,
        request.baseVersion,
      ),
    'bible:setSettings': (request) =>
      vaults(request.vaultId).setSettings(request.vaultId, {
        copyOriginals: request.copyOriginals,
      }),
    'bible:applyKitUpdate': (request) =>
      vaults(request.vaultId).applyKitUpdate(request.vaultId, {
        sections: request.sections,
        fields: request.fields,
      }),
    'bible:dismissKitUpdate': (request) =>
      vaults(request.vaultId).dismissKitUpdate(request.vaultId),
    'app:openExternal': async (request) => ({ opened: await openExternal(request.url) }),
    'journal:home': async () => {
      const { current, problem } = await journal.home()
      return { current, problem, suggestedFolder: suggestedJournalFolder }
    },
    'journal:create': (request) => journal.create(request.folder, JOURNAL_KIT, 'Study journal'),
    'journal:open': (request) => journal.open(request.path),
    'journal:today': (request) => journal.today(request.vaultId),
    'journal:newSession': (request) => journal.newSession(request.vaultId),
    'journal:calendar': (request) => ({ days: journal.calendar(request.vaultId, request.year) }),
    'journal:topic': (request) => journal.topicProgress(request.vaultId, request.path),
    'journal:resources': (request) => ({ items: journal.resources(request.vaultId) }),
    'journal:addImages': (request) =>
      addPracticeImages(journal, references, {
        vaultId: request.vaultId,
        path: request.path,
        items: request.items,
        alsoLibrary: request.alsoLibrary,
        baseVersion: request.baseVersion,
      }),
    'refs:bibleUses': (request) => {
      const hashes = references
        .assetInfo([request.id])
        .flatMap((info) => [info.imageHash, info.thumbHash])
      return {
        uses: bible.assetUses(hashes).map(({ vaultTitle, vaultPath, path, title }) => ({
          vaultTitle,
          vaultPath,
          path,
          title,
        })),
      }
    },
    'bible:saveEntry': (request) =>
      vaults(request.vaultId).saveEntry(
        request.vaultId,
        request.path,
        request.body,
        request.baseVersion,
        request.force,
      ),
    'bible:renameEntry': (request) =>
      vaults(request.vaultId).renameEntry(request.vaultId, request.path, request.title),
    'bible:deleteEntry': (request) =>
      vaults(request.vaultId).deleteEntry(request.vaultId, request.path),
    'bible:restoreEntry': (request) =>
      vaults(request.vaultId).restoreEntry(request.vaultId, request.trashPath, request.path),
    'bible:search': (request) => vaults(request.vaultId).search(request.vaultId, request.text),
    'bible:setSections': (request) =>
      vaults(request.vaultId).setSections(request.vaultId, request.sections),
    'bible:removeSection': (request) =>
      vaults(request.vaultId).removeSection(request.vaultId, request.sectionId),
    'bible:restoreSection': (request) =>
      vaults(request.vaultId).restoreSection(
        request.vaultId,
        request.trashPath,
        request.section,
        request.position,
      ),
  }
}
