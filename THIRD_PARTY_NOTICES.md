# Third-Party Notices

This file records third-party work that CtxAlloc adapted, together with the
license notices that work requires.

CtxAlloc depends on external packages through its manifests; this document covers
source-level adaptation, not ordinary package dependencies.

---

## obsidian-ai-hub

- Project: `zinverno/obsidian-ai-hub`
- Reference commit: `e592cbc99d27259db77e05fa06a833f91169cf89`
- License: MIT
- Adapted in: `packages/application/src/markdown-chunker.ts`
- Decision record: [DEC-029](./docs/DECISIONS.md)

The structural Markdown scanning design in the CtxAlloc chunker was adapted from
that project's `chunking/markdownChunker.ts`. The reused ideas are the
CRLF-aware line scan with exact offsets, ATX heading recognition with a heading
level stack, fence-aware heading detection for backtick and tilde fences, strict
source-only frontmatter detection, and the treatment of lists, blockquotes and
callouts, tables, and HTML blocks as atomic logical units.

The CtxAlloc implementation is a project-owned rewrite. It budgets in tokens
rather than characters, stores exact source text as block content instead of a
normalized body with a rendered breadcrumb, produces no overlap between canonical
blocks, uses SHA-256 rather than the reference project's non-cryptographic
`stableHash`, derives identity from source-document identity rather than from a
vault path, reports one-based line numbers, and imports no Obsidian API or
metadata cache type.

The reference project's license notice is preserved below.

```text
MIT License

Copyright (c) 2026 Zinvernix

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
