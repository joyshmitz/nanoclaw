#!/bin/bash
# Watch upstream PR #110 and notify when merged
PR_REPO="gavrielc/nanoclaw"
PR_NUMBER=110

state=$(gh pr view "$PR_NUMBER" --repo "$PR_REPO" --json state --jq '.state')

if [ "$state" = "MERGED" ]; then
  osascript -e "display notification \"PR #$PR_NUMBER merged in $PR_REPO! Run: git fetch upstream && git rebase upstream/main\" with title \"NanoClaw upstream\" sound name \"Glass\""
  echo "MERGED — час підтягувати!"
  # Remove from cron after merge
  crontab -l 2>/dev/null | grep -v "watch-pr.sh" | crontab -
  echo "(cron job removed)"
else
  echo "PR #$PR_NUMBER: $state"
fi
