import { afterEach, describe, expect, it } from 'vitest'

import {
  NOTEBOOK_SECTIONS,
  clipLatestMarkdown,
  getNotebookPageId,
  loadNotebookConfig,
  normalizeReadMaxChars,
} from '../notebook'

const PAGE_IDS = Object.fromEntries(
  NOTEBOOK_SECTIONS.map((section, index) => [section, `${String(index + 1).padStart(32, '0')}`]),
)

describe('notebook config', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it('stays disabled without notebook mode', () => {
    const config = loadNotebookConfig({})
    expect(config).toEqual({ enabled: false, pageMap: {} })
  })

  it('loads all fixed notebook sections from one JSON map', () => {
    const config = loadNotebookConfig({
      NOTEBOOK_MODE: 'true',
      NOTEBOOK_PAGE_MAP: JSON.stringify(PAGE_IDS),
    })

    expect(config.enabled).toBe(true)
    expect(getNotebookPageId(config, '私人日记')).toBe(PAGE_IDS['私人日记'])
    expect(getNotebookPageId(config, '收藏区')).toBe(PAGE_IDS['收藏区'])
  })

  it('fails closed when a fixed section is missing', () => {
    const incomplete = { ...PAGE_IDS }
    delete incomplete['收藏区']

    expect(() =>
      loadNotebookConfig({
        NOTEBOOK_MODE: 'true',
        NOTEBOOK_PAGE_MAP: JSON.stringify(incomplete),
      }),
    ).toThrow('收藏区')
  })
})

describe('notebook read limits', () => {
  it('uses a small default and clamps explicit values', () => {
    expect(normalizeReadMaxChars(undefined)).toBe(8000)
    expect(normalizeReadMaxChars(10)).toBe(1000)
    expect(normalizeReadMaxChars(999999)).toBe(30000)
  })

  it('returns only the latest characters when clipping is needed', () => {
    const result = clipLatestMarkdown('abcdefghij', 4)
    expect(result).toEqual({ markdown: 'ghij', clipped: true })
  })
})
