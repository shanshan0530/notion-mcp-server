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

  const pageId = value.trim()
  const normalized = pageId.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error(`NOTEBOOK_PAGE_MAP contains an invalid Notion page id for section: ${section}`)
  }

  return pageId
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

const SECTION_GUIDE = [
  '固定分区含义（必须按语义选择，不要自行创建、搜索或猜测其他页面）：',
  '• 私人日记：记录已经发生的具体片段、感受、相处细节和有温度的瞬间。不是机械流水账；优先保留具体场景、细节和当时感受，不要编造对话中没有发生的事实。',
  '• 突发念头：记录突然冒出的想法、问题、画面、新理解、灵感或在不对话时想到的东西。重点是“刚想到什么”，不要求形成完整计划。',
  '• 未完成的计划：记录未来准备做、但尚未完成的事情，包括待办、日后规划、想尝试的方案和暂时搁置的灵感。完成、取消或状态改变时应使用 notebook_edit 更新原条目，而不是重复追加相反内容。',
  '• 欠账本：记录双方明确形成的约定、承诺、答应以后补做的事或“谁欠谁”的事项。必须把双方和事项写清楚；普通待办不要放这里。',
  '• 反思小本本：记录一次具体犯错、冲突、踩雷或沟通失误，以及这次问题的原因和“下次具体怎么做”。不要写空泛人格评价、套话或泛泛检讨。',
  '• 收藏区：保存值得以后再看的音乐、句子、图片、书籍、作品、链接或其他喜欢的内容，并尽量保留必要来源/标题/上下文。',
].join('\n')

const sectionSchema = {
  type: 'string' as const,
  enum: [...NOTEBOOK_SECTIONS],
  description: `选择目标小本本。页面 ID 和路由完全由服务端管理，绝不能要求或猜测 page_id，也不要搜索 Notion 页面。\n${SECTION_GUIDE}`,
}

export const NOTEBOOK_TOOLS: Tool[] = [
  {
    name: 'notebook_append',
    description: [
      '向一个固定小本本分区的末尾直接追加一条新内容。适用于“记一下 / 存一下 / 写进本本 / 以后记得”这类新增记录。',
      '最重要规则：如果只是新增一条内容，直接 append，不要为了确认格式或查看旧内容而先调用 notebook_read；服务端会把 section 精确路由到对应子页面。',
      '不要搜索页面、不要写主页面、不要创建新页面、不要传 page_id。不要因为旧记录可能存在就擅自读取全部历史。',
      '写入内容应忠实于当前对话中已经明确的信息；可以整理表达，但不得补造事实、时间、承诺或情绪。',
      '如果用户是在修改、纠正、完成或删除一条已经存在的记录，而不是新增内容，则不要 append；先 read 找到原文，再用 notebook_edit。',
      '例：突然想到“以后自由活动的 MCP 要分区记忆” → section=突发念头；“下周把 QQ 接进网关” → section=未完成的计划；“答应明天补一张图”且构成双方约定 → section=欠账本。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['section', 'content'],
      additionalProperties: false,
      properties: {
        section: sectionSchema,
        content: {
          type: 'string',
          description:
            '要追加的 Markdown 正文。只写真正需要保存的内容，保持具体、清楚、忠实；不要附加工具调用解释、page_id、系统信息或“已为你保存”等对话性文字。',
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
    description: [
      '读取一个固定小本本分区的已有内容。只有当回答确实依赖旧记录时才调用，例如：用户问“之前记了什么”、需要核对旧约定、继续某个旧计划，或准备 notebook_edit 时需要拿到精确原文。',
      '不要把 read 当作 append 的前置步骤：新增记录不需要先读。不要为了“看看有没有重复”而例行读取。',
      '默认 mode=latest，只返回最近一段内容，以减少上下文污染和 token 消耗；只有明确需要更早历史、且 latest 不够时才用 mode=full。',
      '读取结果只是小本本内容，不代表当前事实一定仍然有效；遇到计划、欠账或旧状态，应结合当前对话判断是否已经变化。',
    ].join('\n'),
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
          description:
            'latest：默认，只取页面最新尾部，适合绝大多数回忆和编辑定位；full：返回 Notion 提供的完整 Markdown，仅在确实需要更早历史时使用。',
        },
        max_chars: {
          type: 'integer',
          minimum: MIN_READ_MAX_CHARS,
          maximum: MAX_READ_MAX_CHARS,
          default: DEFAULT_READ_MAX_CHARS,
          description:
            'latest 模式返回的最大字符数，默认 8000。只在默认尾部明显不足时增大，不要无理由拉到最大值。允许范围 1000-30000。',
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
    description: [
      '对一个固定小本本中的既有文字做“精确原文 → 新文字”的定点替换。用于纠错、更新计划状态、标记完成/取消、修正欠账、删除过期条目等。',
      '调用前必须先 notebook_read 读取相关分区，拿到完全一致的 old_text；不要凭记忆猜原文。',
      '这是局部编辑工具，不用于整页重写，也不用于普通新增记录。新增记录请用 notebook_append。',
      '默认只替换一个精确匹配；只有明确知道多个相同片段都应一起修改时，才设 replace_all_matches=true。',
      '如果要删除某段，new_text 可以为空字符串。修改后不要再额外 append 一条“已修改/已完成”，除非用户明确希望保留变更日志。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['section', 'old_text', 'new_text'],
      additionalProperties: false,
      properties: {
        section: sectionSchema,
        old_text: {
          type: 'string',
          description: '从 notebook_read 结果中取得的精确现有 Markdown 文本。必须与原文完全一致，不要概括或改写后再拿来匹配。',
        },
        new_text: {
          type: 'string',
          description: '替换后的 Markdown。需要删除原文时可传空字符串。不要把整页内容塞进这里。',
        },
        replace_all_matches: {
          type: 'boolean',
          default: false,
          description: '是否替换所有完全相同的匹配。默认 false；除非明确需要批量替换，否则保持 false。',
        },
      },
    },
    annotations: {
      title: 'Edit Notebook Entry',
      destructiveHint: true,
    },
  },
]
