#!/bin/bash

# Simple shell script to classify files using llama_server
# Usage: ./test_classify.sh <file_path> [server_url]

set -e

FILE_PATH="${1:-}"
SERVER_URL="${2:-http://localhost:8000}"
MODEL="${MODEL:-local-model}"
MAX_TEXT_LENGTH="${MAX_TEXT_LENGTH:-4096}"

if [ -z "$FILE_PATH" ]; then
    echo "Usage: $0 <file_path> [server_url]"
    echo "Example: $0 document.txt"
    echo "Example: $0 invoice.pdf http://localhost:8000"
    exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
    echo "Error: File not found: $FILE_PATH" >&2
    exit 1
fi

# Get file name and extension
FILE_NAME=$(basename "$FILE_PATH")
FILE_EXT="${FILE_NAME##*.}"

# Check if it's an image (simple check)
IS_IMAGE=false
case "$FILE_EXT" in
    jpg|jpeg|png|gif|bmp|webp|svg)
        IS_IMAGE=true
        ;;
esac

# Read file content
if [ "$IS_IMAGE" = true ]; then
    # For images, encode as base64 (note: this is a simple approach)
    # In practice, you'd want to use Python for proper image handling
    echo "Warning: Image files require base64 encoding. Use test_classify.py for better image support." >&2
    CONTENT_PREVIEW="[Image file: $FILE_NAME]"
else
    # Read text content (limit to first 4096 characters)
    CONTENT_PREVIEW=$(head -c "$MAX_TEXT_LENGTH" "$FILE_PATH" 2>/dev/null || echo "")
fi

# Build the prompt
PROMPT=$(cat <<EOF
You are a file organizer. Analyze the text content and provide classification and naming suggestions.

  **Task 1: Category Classification**
  - Create a category path with EXACTLY 2 levels separated by forward slash (/)
  - Use Title Case for all category levels (e.g., "Personal/Medical Records")
  - First level should be ONE of these broad categories:
    Business, Personal, Finance, Health, Education, Entertainment, Work, Travel, Legal, Technology, Science, Art, Music, Sports, Media, Documents, Archives
  - Second level should be a specific subcategory relevant to content:
    Examples: Invoices, Reports, Photos, Recipes, Projects, Research, Contracts, Receipts, Presentations, Notes
  - If content doesn't fit clearly, use "Uncategorized/General"
  - Never create categories deeper than 2 levels

  **Task 2: Filename Suggestion**
  - Provide a descriptive filename base (no file extension) using lowercase with underscores
  - Format: {primary_topic}_{entity}_{date_or_identifier}
    - primary_topic: main subject (1-2 words, e.g., "invoice", "meeting_notes", "project_proposal")
    - entity: company/person/organization if identifiable (e.g., "acme_corp", "john_smith")
    - date_or_identifier: date in YYYY-MM-DD or unique identifier if present
  - If any component is missing, omit it (minimum: just primary_topic)
  - Examples: "invoice_acme_corp_2024-03-15", "recipe_chocolate_cake", "contract_freelance_2024"
  - Keep total length under 50 characters

  **Output Format**: Return ONLY valid JSON with these exact keys:
  {
    "category_path": "Category/Subcategory",
    "suggested_filename": "descriptive_name_here",
    "confidence": 0.85
  }

  Original filename: $FILE_NAME
Content (truncated to $MAX_TEXT_LENGTH chars):
$CONTENT_PREVIEW
EOF
)

# Build JSON request body
JSON_BODY=$(jq -n \
    --arg model "$MODEL" \
    --arg system_msg "Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1)." \
    --arg prompt "$PROMPT" \
    '{
        "model": $model,
        "messages": [
            {"role": "system", "content": $system_msg},
            {"role": "user", "content": $prompt}
        ],
        "temperature": 0.2,
        "max_tokens": 512,
        "stream": false
    }')

# Send request
echo "📤 Sending request to: ${SERVER_URL}/v1/chat/completions" >&2
echo "📄 File: $FILE_NAME" >&2

RESPONSE=$(curl -s -X POST "${SERVER_URL}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$JSON_BODY")

# Extract and parse the response
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')

if [ -z "$CONTENT" ]; then
    echo "Error: Invalid response from server" >&2
    echo "$RESPONSE" | jq '.' >&2
    exit 1
fi

# Clean up markdown code blocks if present
CLEANED_CONTENT=$(echo "$CONTENT" | sed 's/^```json$//; s/^```$//' | sed '/^$/d')

# Try to parse as JSON
if echo "$CLEANED_CONTENT" | jq . >/dev/null 2>&1; then
    echo "$CLEANED_CONTENT" | jq '.'
else
    echo "Warning: Response is not valid JSON" >&2
    echo "$CLEANED_CONTENT"
fi

