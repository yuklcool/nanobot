"""Bounded, gateway-owned UI jobs, independent of routed Agent delivery."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Literal, ParamSpec, TypeVar

from loguru import logger

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
            logger.bind(event="openui_job_rejected", turn_id=key[3], reason="closed" if self._closed else "duplicate").info("OpenUI job rejected")
            return False
        if len(self._tasks) >= self.capacity:
            logger.bind(event="openui_job_rejected", turn_id=key[3], reason="capacity").warning("OpenUI job rejected")
            return False

        queued_at = time.monotonic()

        async def run() -> None:
            status, error_type = "complete", None
            queue_ms: int | None = None
            with logger.contextualize(turn_id=key[3], session_generation=key[2], session_key=key[1]):
                try:
                    async with asyncio.timeout(self.timeout):
                        async with self._slots:
                            queue_ms = round((time.monotonic() - queued_at) * 1000)
                            await work()
                except asyncio.CancelledError:
                    status = "cancelled"
                    await shield_and_drain(failed("cancelled"))
                    raise
                except TimeoutError:
                    status = "timeout"
                    await failed("timeout")
                except Exception as error:
                    status, error_type = "failed", type(error).__name__
                    await failed("failed")
                finally:
                    duration_ms = round((time.monotonic() - queued_at) * 1000)
                    logger.bind(event="openui_job_completed", status=status, queue_ms=queue_ms,
                                duration_ms=duration_ms, error_type=error_type).info(
                        "OpenUI job status={} queue_ms={} duration_ms={} error_type={}", status, queue_ms, duration_ms, error_type,
                    )

        task = asyncio.create_task(run(), name="nanobot-openui-job")
        self._tasks[key] = task

        def done(completed: asyncio.Task[None]) -> None:
            if self._tasks.get(key) is completed:
                self._tasks.pop(key, None)
            if not completed.cancelled():
                error = completed.exception()
                if error is not None:
                    logger.bind(event="openui_job_cleanup_failed", turn_id=key[3], error_type=type(error).__name__).warning("OpenUI cleanup failed")

        task.add_done_callback(done)
        return True

    async def cancel(self, key: JobKey) -> None:
        task = self._tasks.get(key)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def cancel_session(self, session_key: str, *, generation: str | None = None) -> None:
        tasks = [task for key, task in self._tasks.items()
                 if key[1] == session_key and (generation is None or key[2] == generation)]
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
