from __future__ import annotations


class GoogleImageAutomationError(RuntimeError):
    code: str = "automation_error"

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code


class LoginRequiredError(GoogleImageAutomationError):
    code = "login_required"


class SelectorNotFoundError(GoogleImageAutomationError):
    code = "selector_not_found"


class GenerationTimeoutError(GoogleImageAutomationError):
    code = "generation_timeout"


class DownloadError(GoogleImageAutomationError):
    code = "download_error"

