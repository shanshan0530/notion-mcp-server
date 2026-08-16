import fs from 'node:fs'
import path from 'node:path'

import { OpenAPIV3 } from 'openapi-types'
import OpenAPISchemaValidator from 'openapi-schema-validator'

import { MCPProxy } from './openapi-mcp-server/mcp/proxy'
import { NotebookMCPProxy } from './openapi-mcp-server/mcp/notebook-proxy'

export class ValidationError extends Error {
  constructor(public errors: any[]) {
    super('OpenAPI validation failed')
    this.name = 'ValidationError'
  }
}

async function loadOpenApiSpec(specPath: string, baseUrl: string | undefined): Promise<OpenAPIV3.Document> {
  let rawSpec: string

  try {
    rawSpec = fs.readFileSync(path.resolve(process.cwd(), specPath), 'utf-8')
  } catch (error) {
    console.error('Failed to read OpenAPI specification file:', (error as Error).message)
    process.exit(1)
  }

  // Parse and validate the OpenApi Spec
  try {
    const parsed = JSON.parse(rawSpec)

    // Override baseUrl if specified.
    if (baseUrl) {
      parsed.servers[0].url = baseUrl
    }

    return parsed as OpenAPIV3.Document
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error
    }
    console.error('Failed to parse OpenAPI spec:', (error as Error).message)
    process.exit(1)
  }
}

function notebookModeEnabled(): boolean {
  return new Set(['1', 'true', 'yes', 'on']).has((process.env.NOTEBOOK_MODE ?? '').trim().toLowerCase())
}

export async function initProxy(
  specPath: string,
  baseUrl: string | undefined,
  headers?: Record<string, string>,
) {
  const openApiSpec = await loadOpenApiSpec(specPath, baseUrl)
  const proxy = notebookModeEnabled()
    ? new NotebookMCPProxy('Notion Notebook', openApiSpec, headers)
    : new MCPProxy('Notion API', openApiSpec, headers)

  return proxy
}
