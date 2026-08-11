---
description: Write a commit message and push.
user-invocable: true
---

# Deploy

## Steps

1. Run `git status` and `git diff --stat` to see what changed.
2. If there are no changes, skip to step 6.
3. Write a commit message using this format: one summary line, blank line, then bullet points starting with "- ". Base it on the actual diff content.
4. Show the proposed commit message to the user and ask for approval. Do not proceed until the user confirms.
5. Once approved, stage the relevant files (`git add` — never stage .env or secrets), commit, and push.
6. Show the user the final output including the GitHub release link.

## Commit message format

```
Short summary line (imperative mood)

- Bullet point describing a change
- Another bullet point
```

## Notes

- Never add `Co-Authored-By` lines to commit messages in this repo.
