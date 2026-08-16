import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OpenAPIV3 } from 'openapi-types'

import { HttpClient, HttpClientError } from '../client/http-client'
import {
  NOTEBOOK_TOOLS,
  clipLatestMarkdown,
  getNotebookPageId,
  loadNotebookConfig,
  normalizeReadMaxChars,
} from './notebook'

type NotebookOperation = OpenAPIV3.OperationObject & { method: string; path: string }

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return value
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`)
  }
  return value
}

export class NotebookMCPProxy {
  private server: Server
  private httpClient: HttpClient
  private config = loadNotebookConfig()
  private retrieveOperation: NotebookOperation
  private updateOperation: NotebookOperation

  constructor(name: string, openApiSpec: OpenAPIV3.Document, headers?: Record<string, string>) {
    if (!this.config.enabled) {
      throw new Error('NotebookMCPProxy requires NOTEBOOK_MODE=true.')
    }

    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })

    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }

    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: headers ?? this.parseHeadersFromEnv(),
      },
      openApiSpec,
    )

    this.retrieveOperation = this.getOperation(openApiSpec, '/v1/pages/{page_id}/markdown', 'get')
    this.updateOperation = this.getOperation(openApiSpec, '/v1/pages/{page_id}/markdown', 'patch')

    this.setupHandlers()
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: NOTEBOOK_TOOLS,
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawParams } = request.params
      const params = (rawParams ?? {}) as Record<string, unknown>

      try {
        switch (name) {
          case 'notebook_append':
            return await this.append(params)
          case 'notebook_read':
            return await this.read(params)
          case 'notebook_edit':
            return await this.edit(params)
          default:
            throw new Error(`Method ${name} not found`)
        }
      } catch (error) {
        console.error('Error in notebook tool call', error instanceof Error ? error.message : 'Unknown error')
        if (error instanceof HttpClientError) {
          const data = error.data?.response?.data ?? error.data ?? {}
          return this.textResult({
            status: 'error',
            ...(typeof data === 'object' ? data : { data }),
          })
        }
        throw error
      }
    })
  }

  private async append(params: Record<string, unknown>) {
    const section = requireString(params.section, 'section')
    const pageId = getNotebookPageId(this.config, section)
    const content = requireString(params.content, 'content')

    await this.httpClient.executeOperation(this.updateOperation, {
      page_id: pageId,
      type: 'insert_content',
      insert_content: {
        content,
        position: { type: 'end' },
      },
    })

    return this.textResult({
      status: 'ok',
      action: 'append',
      section,
    })
  }

  private async read(params: Record<string, unknown>) {
    const section = requireString(params.section, 'section')
    const pageId = getNotebookPageId(this.config, section)
    const mode = params.mode ?? 'latest'

    if (mode !== 'latest' && mode !== 'full') {
      throw new Error('mode must be either "latest" or "full".')
    }

    const response = await this.httpClient.executeOperation<Record<string, unknown>>(this.retrieveOperation, {
      page_id: pageId,
      include_transcript: false,
    })

    const sourceMarkdown = typeof response.data.markdown === 'string' ? response.data.markdown : ''
    const sourceTruncated = response.data.truncated === true

    if (mode === 'full') {
      return this.textResult({
        status: 'ok',
        action: 'read',
        section,
        mode,
        markdown: sourceMarkdown,
        clipped: false,
        notion_truncated: sourceTruncated,
      })
    }

    const maxChars = normalizeReadMaxChars(params.max_chars)
    const clipped = clipLatestMarkdown(sourceMarkdown, maxChars)

    return this.textResult({
      status: 'ok',
      action: 'read',
      section,
      mode,
      markdown: clipped.markdown,
      clipped: clipped.clipped,
      notion_truncated: sourceTruncated,
    })
  }

  private async edit(params: Record<string, unknown>) {
    const section = requireString(params.section, 'section')
    const pageId = getNotebookPageId(this.config, section)
    const oldText = requireString(params.old_text, 'old_text')
    const newText = requireText(params.new_text, 'new_text')
    const replaceAllMatches = params.replace_all_matches ?? false

    if (typeof replaceAllMatches !== 'boolean') {
      throw new Error('replace_all_matches must be a boolean.')
    }

    await this.httpClient.executeOperation(this.updateOperation, {
      page_id: pageId,
      type: 'update_content',
      update_content: {
        content_updates: [
          {
            old_str: oldText,
            new_str: newText,
            replace_all_matches: replaceAllMatches,
          },
        ],
      },
    })

    return this.textResult({
      status: 'ok',
      action: 'edit',
      section,
    })
  }

  private getOperation(
    openApiSpec: OpenAPIV3.Document,
    path: string,
    method: 'get' | 'patch',
  ): NotebookOperation {
    const pathItem = openApiSpec.paths?.[path] as OpenAPIV3.PathItemObject | undefined
    const operation = pathItem?.[method]

    if (!operation || !('operationId' in operation)) {
      throw new Error(`Required Notion Markdown operation is missing: ${method.toUpperCase()} ${path}`)
    }

    return { ...operation, method, path }
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers === 'object' && headers !== null && Object.keys(headers).length > 0) {
          return headers
        }
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
      }
    }

    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      return {
        Authorization: `Bearer ${notionToken}`,
      }
    }

    return {}
  }

  private textResult(data: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(data),
        },
      ],
    }
  }

  async connect(transport: Transport) {
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
