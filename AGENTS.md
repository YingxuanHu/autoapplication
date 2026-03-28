<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Rules

- Use the repository state as the source of truth. Notes in `.claude/` and `README.md` may lag behind the code.
- This product is a North America-only job search and application engine for tech and finance first.
- Optimize for volume and time saved, but never at the expense of application quality.
- Keep the feed first and the apply flow second. The `/jobs` experience is the primary surface.
- Preserve the distinction between the total live job pool and the stricter auto-apply eligible pool.
- Every job should stay classifiable as `auto-apply eligible`, `review required`, or `manual only`, with a clear reason.
- Deduplication, freshness, expiration tracking, and multi-source source mappings are foundational, not optional.
- Automation is conservative by default. This is not a blind spam-style mass apply bot.
- Extend existing Prisma models, query helpers in `src/lib/queries`, and App Router route handlers before introducing new patterns.
