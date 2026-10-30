"""Cancellation and capacity contracts for detached UI work and SQLite workers."""

import asyncio
import threading

import pytest

from nanobot.openui.coordinator import UIJobCoordinator, store_call
from nanobot.runtime_admission import RuntimeAdmission, RuntimeBusyError


async def test_bounded_jobs_participate_in_maintenance_until_cleanup():
    admission = RuntimeAdmission()
    jobs = UIJobCoordinator(admission, capacity=1)
    started, finish = asyncio.Event(), asyncio.Event()
    failures = []

    async def work():
        started.set()
        await finish.wait()

    async def fail(reason):
        failures.append(reason)

    try:
        key = ("webui", "chat", "generation", "turn")
        assert jobs.schedule(key, work, fail)
        await started.wait()
        assert not jobs.schedule(("webui", "other", "g", "t"), work, fail)
        with pytest.raises(RuntimeBusyError):
            with admission.pause_if_idle(lambda: False):
                pass
        await jobs.cancel(key)
        assert failures == ["cancelled"]
        await jobs.drain()
        with admission.pause_if_idle(lambda: False):
            pass
    finally:
        await jobs.close()


async def test_store_worker_is_drained_before_cancellation_returns():
    started, finish = threading.Event(), threading.Event()
    settled = []

    def write():
        started.set()
        assert finish.wait(2)
        settled.append(True)

    task = asyncio.create_task(store_call(write))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert settled == [True]
    finally:
        finish.set()
        await asyncio.gather(task, return_exceptions=True)
