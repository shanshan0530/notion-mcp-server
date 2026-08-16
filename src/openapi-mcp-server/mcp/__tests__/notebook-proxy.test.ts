import type { OpenAPIV3 } from 'openapi-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpClient } from '../../client/http-client'
import { NotebookMCPProxy } from '../notebook-proxy'
import { NOTEBOOK_SECTIONS } from '../notebook'

vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

const ORIGINAL_ENV = { ...process.env }
const PAGE_IDS = Object.fromEntries(
  NOTEBOOK_SECTIONS.map((section, index) => [section, `${String(index + 1).padStart(32, '0')}`]),
)

function makeSpec(): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    servers: [{ url: 'https://api.notion.com' }],
    info: { title: 'Notion test', version: '1.0.0' },
    paths: {
      '/v1/pages/{page_id}/markdown': {
        get: {
          operationId: 'retrieve-page-markdown',
          parameters: [
            {
              name: 'page_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Success' } },
        },
        patch: {
          operationId: 'update-page-markdown',
          parameters: [
            {
              name: 'page_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: { '200': { description: 'Success' } },
        },
      },
    },
  }
}

describe('NotebookMCPProxy', () => {
  let proxy: NotebookMCPProxy

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NOTEBOOK_MODE: 'true',
      NOTEBOOK_PAGE_MAP: JSON.stringify(PAGE_IDS),
    }
    proxy = new NotebookMCPProxy('notebook-test', makeSpec())
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  function handlers() {
    const server = (proxy as any).server
    return server.setRequestHandler.mock.calls
      .flatMap((call: unknown[]) => call)
      .filter((value: unknown) => typeof value === 'function')
  }

  it('exposes only the three notebook tools', async () => {
    const result = await handlers()[0]()
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'notebook_append',
      'notebook_read',
      'notebook_edit',
    ])
  })

  it('appends directly to the fixed child page without reading first', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: PAGE_IDS['突发念头'] },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    const result = await handlers()[1]({
      params: {
        name: 'notebook_append',
        arguments: {
          section: '突发念头',
          content: '新的念头',
        },
      },
    })

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'update-page-markdown', method: 'patch' }),
      {
        page_id: PAGE_IDS['突发念头'],
        type: 'insert_content',
        insert_content: {
          content: '新的念头',
          position: { type: 'end' },
        },
      },
    )

    expect(JSON.parse(result.content[0].text)).toEqual({
      status: 'ok',
      action: 'append',
      section: '突发念头',
    })
  })

  it('returns only the latest tail by default and does not expose page ids', async () => {
    const markdown = `${'a'.repeat(400)}${'b'.repeat(1000)}`
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { markdown, truncated: false },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    const result = await handlers()[1]({
      params: {
        name: 'notebook_read',
        arguments: {
          section: '私人日记',
          max_chars: 1000,
        },
      },
    })

    const payload = JSON.parse(result.content[0].text)
    expect(payload.markdown).toBe('b'.repeat(1000))
    expect(payload.clipped).toBe(true)
    expect(payload).not.toHaveProperty('page_id')
    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'retrieve-page-markdown', method: 'get' }),
      {
        page_id: PAGE_IDS['私人日记'],
        include_transcript: false,
      },
    )
  })

  it('performs targeted edits through update_content', async () => {
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: PAGE_IDS['未完成的计划'] },
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    await handlers()[1]({
      params: {
        name: 'notebook_edit',
        arguments: {
          section: '未完成的计划',
          old_text: '- [ ] 做事',
          new_text: '- [x] 做事',
        },
      },
    })

    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'update-page-markdown', method: 'patch' }),
      {
        page_id: PAGE_IDS['未完成的计划'],
        type: 'update_content',
        update_content: {
          content_updates: [
            {
              old_str: '- [ ] 做事',
              new_str: '- [x] 做事',
              replace_all_matches: false,
            },
          ],
        },
      },
    )
  })
})
