import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const NOTEBOOK_SECTIONS = [
  '私人日记',
  '突发念头',
  '未完成的计划',
  '欠账本',
  '反思小本本',
  '收藏区',
] as const

export type NotebookSection = (typeof NOTEBOOK_SECTIONS)[number]

export type NotebookConfig = {
  enabled: boolean
  pageMap: Partial<Record<NotebookSection, string>>
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const DEFAULT_READ_MAX_CHARS = 8000
const MIN_READ_MAX_CHARS = 1000
const MAX_READ_MAX_CHARS = 30000

function isNotebookSection(value: string): value is NotebookSection {
  return (NOTEBOOK_SECTIONS as readonly string[]).includes(value)
}

function normalizePageId(value: unknown, section: NotebookSection): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`NOTEBOOK_PAGE_MAP is missing a page id for section: ${section}`)
  }

  const normalized = value.trim().replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error(`NOTEBOOK_PAGE_MAP contains an invalid Notion page id for section: ${section}`)
  }

  return normalized
}

export function loadNotebookConfig(env: NodeJS.ProcessEnv = process.env): NotebookConfig {
  const enabled = TRUE_VALUES.has((env.NOTEBOOK_MODE ?? '').trim().toLowerCase())
  if (!enabled) {
    return { enabled: false, pageMap: {} }
  }

  const rawMap = env.NOTEBOOK_PAGE_MAP
  if (!rawMap) {
    throw new Error(
      'NOTEBOOK_MODE is enabled but NOTEBOOK_PAGE_MAP is missing. Provide a JSON object mapping every notebook section to its Notion page id.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawMap)
  } catch {
    throw new Error('NOTEBOOK_PAGE_MAP must be valid JSON.')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('NOTEBOOK_PAGE_MAP must be a JSON object.')
  }

  const pageMap: Partial<Record<NotebookSection, string>> = {}
  for (const section of NOTEBOOK_SECTIONS) {
    pageMap[section] = normalizePageId((parsed as Record<string, unknown>)[section], section)
  }

  return { enabled: true, pageMap }
}

export function getNotebookPageId(config: NotebookConfig, sectionValue: unknown): string {
  if (typeof sectionValue !== 'string' || !isNotebookSection(sectionValue)) {
    throw new Error(`Unknown notebook section: ${String(sectionValue)}`)
  }

  const pageId = config.pageMap[sectionValue]
  if (!pageId) {
    throw new Error(`No Notion page id configured for notebook section: ${sectionValue}`)
  }

  return pageId
}

export function normalizeReadMaxChars(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_READ_MAX_CHARS
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('max_chars must be an integer.')
  }

  return Math.min(MAX_READ_MAX_CHARS, Math.max(MIN_READ_MAX_CHARS, value))
}

export function clipLatestMarkdown(markdown: string, maxChars: number): { markdown: string; clipped: boolean } {
  if (markdown.length <= maxChars) {
    return { markdown, clipped: false }
  }

  return {
    markdown: markdown.slice(-maxChars),
    clipped: true,
  }
}

const sectionSchema = {
  type: 'string' as const,
  enum: [...NOTEBOOK_SECTIONS],
  description: 'Target notebook section. Use only one of the predefined sections; page ids are resolved internally.',
}

export const NOTEBOOK_TOOLS: Tool[] = [
  {
    name: 'notebook_append',
    description:
      'Append Markdown directly to one fixed notebook section. Use this for journals, sudden thoughts, debts, reflections, saved items, and other append-only notes. Do NOT call notebook_read first just to append a new entry.',
    inputSchema: {
      type: 'object',
      required: ['section', 'content'],
      additionalProperties: false,
      properties: {
        section: sectionSchema,
        content: {
          type: 'string',
          description: 'Markdown content to append at the end of the selected notebook page.',
        },
      },
    },
    annotations: {
      title: 'Append Notebook Entry',
      destructiveHint: false,
    },
  },
  {
    name: 'notebook_read',
    description:
      'Read an existing notebook section. Default mode returns only the latest tail to reduce context usage. Use mode="full" only when older content is genuinely needed.',
    inputSchema: {
      type: 'object',
      required: ['section'],
      additionalProperties: false,
      properties: {
        section: sectionSchema,
        mode: {
          type: 'string',
          enum: ['latest', 'full'],
          default: 'latest',
          description: 'latest returns only the newest tail; full returns the complete Markdown returned by Notion.',
        },
        max_chars: {
          type: 'integer',
          minimum: MIN_READ_MAX_CHARS,
          maximum: MAX_READ_MAX_CHARS,
          default: DEFAULT_READ_MAX_CHARS,
          description: 'Character limit for latest mode. Values are clamped to 1,000-30,000.',
        },
      },
    },
    annotations: {
      title: 'Read Notebook Section',
      readOnlyHint: true,
    },
  },
  {
    name: 'notebook_edit',
    description:
      'Apply a targeted exact-text replacement inside one notebook section. Read the section first so old_text exactly matches existing Markdown. Never use this for ordinary append-only entries.',
    inputSchema: {
      type: 'object',
      required: ['section', 'old_text', 'new_text'],
      additionalProperties: false,
      properties: {
        section: sectionSchema,
        old_text: {
          type: 'string',
          description: 'Exact existing Markdown text to replace.',
        },
        new_text: {
          type: 'string',
          description: 'Replacement Markdown text.',
        },
        replace_all_matches: {
          type: 'boolean',
          default: false,
          description: 'Replace every exact match instead of requiring a single unique match.',
        },
      },
    },
    annotations: {
      title: 'Edit Notebook Entry',
      destructiveHint: true,
    },
  },
]
