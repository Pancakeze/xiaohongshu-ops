from __future__ import annotations


class GeminiSelectors:
    """Centralized selectors to ease maintenance when UI changes."""

    # Landing / chat input (best-effort; Gemini has multiple UIs)
    PROMPT_TEXTAREA = "textarea"
    PROMPT_CONTENTEDITABLE = "[contenteditable='true']"

    # Buttons
    SEND_BUTTON = "button[type='submit']"

    # Login heuristics (best-effort)
    SIGN_IN_TEXT = "text=/sign in|log in|登录/i"
    ACCOUNT_CHOOSER_TEXT = "text=/choose an account|选择账号/i"

    # Image heuristics within conversation
    # Prefer stable: any <img> inside main content.
    MAIN = "main"
    IMAGE_IN_MAIN = "main img"

