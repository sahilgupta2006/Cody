def helper():
    """Shared helper used across modules."""
    return 42


def worker_fn():
    return helper() + 1
