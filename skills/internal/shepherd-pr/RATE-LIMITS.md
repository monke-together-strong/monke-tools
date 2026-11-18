# CodeRabbit rate limits

The latest changes run from the commit of CodeRabbit's latest review to the
head, or cover the whole PR when it has reviewed none.

Judge whether the latest changes need care. Weigh the kind of change, not its
size: behavior, interfaces, data, and security need care; docs, renames, and
mechanical fixes are routine.

- Routine: record CodeRabbit as unavailable for this head; its review is
  resolved.
- Needs care. In a clean PR checkout, review the whole PR with
  `coderabbit review --agent --deep --committed --fresh --base <PR base>`.
  Follow [Address feedback](SKILL.md#address-feedback) for the findings.
  If the CLI is also rate limited, record CodeRabbit as unavailable for this head.
