import httpx

TASK_INDEX_KEY = "tasks:index"


class StateStore:
    """Reads/writes task records via the Dapr state API.

    Redis exposes no key enumeration through Dapr, so task ids are tracked in a
    `tasks:index` array key.
    """

    def __init__(self, base_url: str) -> None:
        # base_url e.g. http://localhost:3510/v1.0/state/statestore
        self._base = base_url.rstrip("/")

    async def _get(self, client: httpx.AsyncClient, key: str):
        resp = await client.get(f"{self._base}/{key}")
        if resp.status_code == 204 or not resp.content:
            return None
        resp.raise_for_status()
        return resp.json()

    async def _save(self, client: httpx.AsyncClient, key: str, value) -> None:
        resp = await client.post(self._base, json=[{"key": key, "value": value}])
        resp.raise_for_status()

    async def list_task_ids(self) -> list[str]:
        async with httpx.AsyncClient(timeout=30) as client:
            return (await self._get(client, TASK_INDEX_KEY)) or []

    async def get_task(self, task_id: str) -> dict | None:
        async with httpx.AsyncClient(timeout=30) as client:
            return await self._get(client, f"task:{task_id}")

    async def save_task(self, task: dict) -> None:
        async with httpx.AsyncClient(timeout=30) as client:
            await self._save(client, f"task:{task['id']}", task)

    async def seed_task(self, task: dict) -> None:
        """Persist a new task and add it to the index so the cron tick picks it up.

        save_task only writes the record; seeding also registers the id in tasks:index, the
        same read-modify-write the invoke script does, so a task created in-process (e.g. from a
        pub/sub event) becomes visible to the cron-tick scan.
        """
        async with httpx.AsyncClient(timeout=30) as client:
            await self._save(client, f"task:{task['id']}", task)
            index = (await self._get(client, TASK_INDEX_KEY)) or []
            if task["id"] not in index:
                index.append(task["id"])
                await self._save(client, TASK_INDEX_KEY, index)
