#!/usr/bin/env python3
"""
Simple test tool to classify files using llama_server.
Uploads a file and gets classification and suggested filename.
"""

import sys
import json
import base64
import mimetypes
import requests
from pathlib import Path

# Default configuration
DEFAULT_SERVER_URL = "http://localhost:8000"
DEFAULT_MODEL = "local-model"
DEFAULT_MAX_TEXT_LENGTH = 4096

def is_image_file(file_path: Path) -> bool:
    """Check if file is an image based on MIME type."""
    mime_type, _ = mimetypes.guess_type(str(file_path))
    return mime_type and mime_type.startswith('image/')

def read_file_content(file_path: Path) -> tuple[str | None, str | None, str]:
    """
    Read file content and return (text_content, base64_image, mime_type).
    Returns text for text files, base64 for images.
    """
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
    
    if is_image_file(file_path):
        # Read image as base64
        with open(file_path, 'rb') as f:
            image_data = f.read()
            base64_image = base64.b64encode(image_data).decode('utf-8')
        
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = 'image/jpeg'  # Default
        
        return None, base64_image, mime_type
    else:
        # Read text file
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                text = f.read()
            return text, None, 'text/plain'
        except UnicodeDecodeError:
            # Try binary mode for non-text files
            with open(file_path, 'rb') as f:
                content = f.read()
                # Try to decode as text, limit to first 4096 bytes
                try:
                    text = content[:DEFAULT_MAX_TEXT_LENGTH].decode('utf-8', errors='ignore')
                    return text, None, 'application/octet-stream'
                except:
                    return None, None, 'application/octet-stream'

def build_classification_prompt(original_name: str, text_content: str | None, 
                                is_image: bool, max_text_length: int = DEFAULT_MAX_TEXT_LENGTH) -> str:
    """Build the classification prompt based on the default template."""
    
    content_type = "image" if is_image else "text content"
    
    prompt = f"""You are a file organizer. Analyze the {content_type} and provide classification and naming suggestions.

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
  - Format: {{primary_topic}}_{{entity}}_{{date_or_identifier}}
    - primary_topic: main subject (1-2 words, e.g., "invoice", "meeting_notes", "project_proposal")
    - entity: company/person/organization if identifiable (e.g., "acme_corp", "john_smith")
    - date_or_identifier: date in YYYY-MM-DD or unique identifier if present
  - If any component is missing, omit it (minimum: just primary_topic)
  - Examples: "invoice_acme_corp_2024-03-15", "recipe_chocolate_cake", "contract_freelance_2024"
  - Keep total length under 50 characters
  {f'**For images**: Describe visible content, text, objects, or documents to determine category and filename.' if is_image else ''}

  **Output Format**: Return ONLY valid JSON with these exact keys:
  {{
    "category_path": "Category/Subcategory",
    "suggested_filename": "descriptive_name_here",
    "confidence": 0.85
  }}

  Original filename: {original_name}"""
    
    if is_image:
        prompt += "\n\n[Image data - see attached image]"
    elif text_content:
        truncated = text_content[:max_text_length]
        prompt += f"\n\nContent (truncated to {max_text_length} chars):\n{truncated}"
    
    return prompt

def classify_file(file_path: Path, server_url: str = DEFAULT_SERVER_URL, 
                  model: str = DEFAULT_MODEL, max_text_length: int = DEFAULT_MAX_TEXT_LENGTH,
                  supports_vision: bool = False) -> dict:
    """
    Classify a file using the llama_server.
    Returns the classification result.
    """
    # Read file content
    text_content, base64_image, mime_type = read_file_content(file_path)
    is_image = base64_image is not None
    
    if is_image and not supports_vision:
        print(f"Warning: Image file detected but vision support is disabled. "
              f"Classification may not work properly.", file=sys.stderr)
    
    # Build prompt
    prompt = build_classification_prompt(
        file_path.name, 
        text_content, 
        is_image,
        max_text_length
    )
    
    # Build request body
    system_message = "Return only valid JSON (no markdown), with keys: category_path, suggested_filename, confidence (0-1)."
    
    if is_image and supports_vision:
        # OpenAI-compatible vision format
        user_content = [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{mime_type};base64,{base64_image}"
                }
            },
            {
                "type": "text",
                "text": prompt
            }
        ]
    else:
        # Text-only format
        user_content = prompt
    
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_content}
        ],
        "temperature": 0.2,
        "max_tokens": 512,
        "stream": False
    }
    
    # Send request
    endpoint = f"{server_url.rstrip('/')}/v1/chat/completions"
    print(f"📤 Sending request to: {endpoint}", file=sys.stderr)
    print(f"📄 File: {file_path.name}", file=sys.stderr)
    print(f"📊 Type: {'Image' if is_image else 'Text'}", file=sys.stderr)
    
    try:
        response = requests.post(endpoint, json=body, timeout=120)
        response.raise_for_status()
        
        result = response.json()
        
        # Extract the message content
        if 'choices' in result and len(result['choices']) > 0:
            content = result['choices'][0]['message']['content']
            
            # Try to parse JSON from the response
            # Sometimes LLMs wrap JSON in markdown code blocks
            content = content.strip()
            if content.startswith('```'):
                # Extract JSON from markdown code block
                lines = content.split('\n')
                json_lines = [line for line in lines if not line.strip().startswith('```')]
                content = '\n'.join(json_lines)
            
            try:
                classification = json.loads(content)
                return classification
            except json.JSONDecodeError as e:
                print(f"⚠️  Warning: Could not parse JSON from response: {e}", file=sys.stderr)
                print(f"Raw response: {content}", file=sys.stderr)
                return {"error": "Failed to parse JSON", "raw_response": content}
        else:
            return {"error": "Unexpected response format", "response": result}
            
    except requests.exceptions.RequestException as e:
        return {"error": f"Request failed: {str(e)}"}

def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Test tool to classify files using llama_server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python test_classify.py document.txt
  python test_classify.py invoice.pdf --server http://localhost:8000
  python test_classify.py photo.jpg --supports-vision
        """
    )
    
    parser.add_argument('file', type=Path, help='Path to file to classify')
    parser.add_argument('--server', default=DEFAULT_SERVER_URL, 
                       help=f'Server URL (default: {DEFAULT_SERVER_URL})')
    parser.add_argument('--model', default=DEFAULT_MODEL,
                       help=f'Model name (default: {DEFAULT_MODEL})')
    parser.add_argument('--max-text-length', type=int, default=DEFAULT_MAX_TEXT_LENGTH,
                       help=f'Maximum text length to send (default: {DEFAULT_MAX_TEXT_LENGTH})')
    parser.add_argument('--supports-vision', action='store_true',
                       help='Enable vision support for image files')
    parser.add_argument('--pretty', action='store_true',
                       help='Pretty print JSON output')
    
    args = parser.parse_args()
    
    # Classify the file
    result = classify_file(
        args.file,
        server_url=args.server,
        model=args.model,
        max_text_length=args.max_text_length,
        supports_vision=args.supports_vision
    )
    
    # Print result
    if args.pretty:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))
    
    # Exit with error code if classification failed
    if 'error' in result:
        sys.exit(1)

if __name__ == '__main__':
    main()

