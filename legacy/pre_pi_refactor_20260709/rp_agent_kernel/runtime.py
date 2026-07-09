from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime

from .kernel import Kernel


class RuntimeScheduler:
    def __init__(
        self,
        kernel: Kernel,
        *,
        now_provider: Callable[[], datetime],
        interval_seconds: float = 15,
    ) -> None:
        self.kernel = kernel
        self.now_provider = now_provider
        self.interval_seconds = max(0.25, float(interval_seconds))
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="rp-agent-runtime-scheduler")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run(self) -> None:
        while True:
            self.tick()
            await asyncio.sleep(self.interval_seconds)

    def tick(self) -> list[dict]:
        return self.kernel.due_events(
            self.now_provider(),
            claim_new=False,
        )


async def stop_runtime_scheduler(scheduler: RuntimeScheduler | None) -> None:
    if scheduler is not None:
        await scheduler.stop()
