# Private Notebook Mode

This fork can run in a restricted notebook mode that exposes only three MCP tools instead of the full Notion API surface:

- `notebook_append` — append Markdown directly to a fixed notebook section without reading it first.
- `notebook_read` — read a section; defaults to the latest 8,000 characters to reduce context usage.
- `notebook_edit` — targeted exact-text replacement after reading the relevant section.

The mode is opt-in. When it is disabled, the server behaves exactly like the normal Notion MCP proxy.

## Environment variables

Set:

```text
NOTEBOOK_MODE=true
```

and provide all fixed child-page mappings in one JSON environment variable:

```json
{
  "私人日记": "<notion-page-id>",
  "突发念头": "<notion-page-id>",
  "未完成的计划": "<notion-page-id>",
  "欠账本": "<notion-page-id>",
  "反思小本本": "<notion-page-id>",
  "收藏区": "<notion-page-id>"
}
```

Store that JSON as the value of `NOTEBOOK_PAGE_MAP`.

Page ids are configuration only and should not be committed to a public repository.

## Safety and routing behavior

Notebook mode fails closed at startup if any fixed section is missing or has an invalid page id. The model never receives page ids and cannot choose arbitrary Notion pages.

Append operations always route directly to the configured child page with `insert_content` at the end. They do not retrieve the page first.

`notebook_read` uses `mode="latest"` by default and returns at most 8,000 characters. `max_chars` can be set from 1,000 to 30,000. Use `mode="full"` only when older content is genuinely required.

`notebook_edit` uses Notion Markdown `update_content` with an exact `old_text` / `new_text` replacement. Read the relevant section first so `old_text` matches the stored Markdown exactly.
