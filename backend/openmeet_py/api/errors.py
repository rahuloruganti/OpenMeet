"""Error shape shared with the React UI: {code, message}."""


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def not_available(feature: str) -> AppError:
    return AppError(
        "not_available",
        f"{feature} is not available in the Python build yet.",
        status=501,
    )
