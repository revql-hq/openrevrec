"""OpenRevRec's local accounting runtime."""

__version__ = "0.1.0"


def open_workspace(path):
    """Open an existing .orr workspace using the public application interface."""
    from .application import Application

    return Application(path)
