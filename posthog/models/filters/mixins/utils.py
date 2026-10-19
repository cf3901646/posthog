from collections.abc import Callable
from functools import lru_cache
from typing import TypeVar

T = TypeVar("T")


# Each decorated function gets one cache slot. Every instance in the process shares it. The slot keys
# on the instance's __hash__ and __eq__, so a class that compares by value, such as a Django model,
# gets the result that another equal instance cached. Use functools.cached_property instead.
def cached_property(func: Callable[..., T]) -> T:
    return property(lru_cache(maxsize=1)(func))  # type: ignore
