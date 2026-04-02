#!/bin/bash
# Pre-commit hook to detect potential secrets in staged files
# Install: cp scripts/pre-commit-secrets.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

PATTERNS=(
    'eyJ[A-Za-z0-9+/=]{20,}'          # JWT/Base64 tokens
    'AKIA[0-9A-Z]{16}'                  # AWS Access Key
    'sk-[a-zA-Z0-9]{20,}'              # OpenAI/Stripe secret keys
    'ghp_[a-zA-Z0-9]{36}'              # GitHub personal access token
    'gho_[a-zA-Z0-9]{36}'              # GitHub OAuth token
    'glpat-[a-zA-Z0-9\-]{20,}'        # GitLab personal access token
    'xox[bpors]-[a-zA-Z0-9\-]+'       # Slack tokens
    'PRIVATE KEY-----'                  # Private keys
)

# Exclude this script and other known false positives
EXCLUDE_FILES="scripts/pre-commit-secrets.sh"

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -vF "$EXCLUDE_FILES")

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

FOUND=0
for pattern in "${PATTERNS[@]}"; do
    MATCHES=$(echo "$STAGED_FILES" | xargs grep -lE "$pattern" 2>/dev/null)
    if [ -n "$MATCHES" ]; then
        echo "WARNING: Potential secret detected matching pattern: $pattern"
        echo "In files:"
        echo "$MATCHES" | sed 's/^/  - /'
        FOUND=1
    fi
done

if [ "$FOUND" -eq 1 ]; then
    echo ""
    echo "Commit blocked. If these are false positives, use: git commit --no-verify"
    exit 1
fi

exit 0
