"""Bounded, gateway-owned UI jobs, independent of routed Agent delivery."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Literal, ParamSpec, TypeVar

from nanobot.runtime_admission import RuntimeAdmission
from nanobot.utils.cancellation import shield_and_drain

_P = ParamSpec("_P")
_T = TypeVar("_T")
JobKey = tuple[str, str, str, str]
JobFailure = Literal["cancelled", "timeout", "failed"]


async def store_call(function: Callable[_P, _T], *args: _P.args, **kwargs: _P.kwargs) -> _T:
    """A cancelled caller still owns its SQLite worker until it has settled."""
    return await shield_and_drain(asyncio.to_thread(function, *args, **kwargs))


class UIJobCoordinator:
    def __init__(
        self, admission: RuntimeAdmission, *, timeout: float = 45,
        concurrency: int = 2, capacity: int = 16,
    ) -> None:
        self.timeout = timeout
        self.capacity = capacity
        self._slots = asyncio.Semaphore(concurrency)
        self._tasks: dict[JobKey, asyncio.Task[None]] = {}
        self._closed = False
        self._unregister = admission.register_pending_work(lambda: bool(self._tasks))
        self._admission = admission

    def schedule(
        self, key: JobKey, work: Callable[[], Awaitable[None]],
        failed: Callable[[JobFailure], Awaitable[None]],
    ) -> bool:
        self._admission.check()
        if self._closed or (key in self._tasks and not self._tasks[key].done()):
            return False
        if len(self._tasks) >= self.capacity:
            return False

        async def run() -> None:
            try:
                async with asyncio.timeout(self.timeout):
                    async with self._slots:
                        await work()
            except asyncio.CancelledError:
                await shield_and_drain(failed("cancelled"))
                raise
            except TimeoutError:
                await failed("timeout")
            except Exception:
                await failed("failed")

        task = asyncio.create_task(run(), name="nanobot-openui-job")
        self._tasks[key] = task

        def done(completed: asyncio.Task[None]) -> None:
            if self._tasks.get(key) is completed:
                self._tasks.pop(key, None)
            if not completed.cancelled():
                completed.exception()  # Observe cleanup failures, never orphan a task exception.

        task.add_done_callback(done)
        return True

    async def cancel(self, key: JobKey) -> None:
        task = self._tasks.get(key)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def cancel_session(self, session_key: str) -> None:
        tasks = [task for key, task in self._tasks.items() if key[1] == session_key]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def drain(self) -> None:
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks.values()), return_exceptions=True)

    async def close(self) -> None:
        self._closed = True
        tasks = tuple(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._unregister()
