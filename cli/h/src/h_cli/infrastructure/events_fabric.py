"""The local event fabric — a supervised `nats-server -js` child plus JetStream plumbing.

The fabric is run the local substrate's way: one binary the OPERATOR provisions (like the agent
CLIs), spawned as a detached child, refused loud by name when missing — never auto-installed. The
JetStream store lives beside the run ledger (config.EVENTS_STORE_DIR) so resetting the local
runtime's state stays one directory tree.

This module owns all IO for `h events`: the server lifecycle (up/down/status) and the async
JetStream client work (streams, the seed publish, the relay's consume loop). The protocol itself
— descriptors, hand-offs, budgets — is the pure sibling `events_protocol`.
"""

import asyncio
import json
import os
import shutil
import signal
import socket
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import nats
import nats.errors
import nats.js.errors
from nats.js.api import ConsumerConfig, DeliverPolicy, RetentionPolicy, StreamConfig

from h_cli.config import EVENTS_STORE_DIR, EVENTS_URL
from h_cli.infrastructure import events_protocol as protocol


class FabricError(RuntimeError):
    """User-presentable fabric failure — missing binary, unreachable server, bad stream state."""


# The relay owns a task for up to ack_wait before the server redelivers it; agent runs are far
# longer, so the consume loop extends the claim with in-progress heartbeats at HEARTBEAT_SECONDS.
# Redelivery is therefore a RELAY-DEATH signal, not a slow-agent one. A message that kills the
# relay MAX_DELIVER times stops being redelivered (the poison-pill backstop).
ACK_WAIT_SECONDS = 120
HEARTBEAT_SECONDS = 30
MAX_DELIVER = 3

# One publish per (group, step) — the duplicate window inside which a redelivered step's re-publish
# of its successor is rejected instead of forking the loop.
DUPLICATE_WINDOW_SECONDS = 600
RESULT_MAX_AGE_SECONDS = 7 * 24 * 3600

_PID_FILE = EVENTS_STORE_DIR / "nats.pid"
_LOG_FILE = EVENTS_STORE_DIR / "nats.log"


def fabric_port() -> int:
    return urlparse(EVENTS_URL).port or 4222


def fabric_running(timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", fabric_port()), timeout=timeout):
            return True
    except OSError:
        return False


def _server_pid() -> int | None:
    try:
        pid = int(_PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    return pid


def start_server() -> dict[str, Any]:
    """Start `nats-server -js` detached; idempotent when the port already answers."""
    if fabric_running():
        return {"running": True, "url": EVENTS_URL, "pid": _server_pid(), "started": False}
    binary = shutil.which("nats-server")
    if binary is None:
        raise FabricError(
            "nats-server is not installed (the fabric is operator-provisioned, like the agent "
            "CLIs). Install it — e.g. https://github.com/nats-io/nats-server/releases — and rerun."
        )
    EVENTS_STORE_DIR.mkdir(parents=True, exist_ok=True)
    log = open(_LOG_FILE, "ab")  # noqa: SIM115 — handed to the child, outlives this call
    proc = subprocess.Popen(
        [
            binary,
            "-js",
            "-sd",
            str(EVENTS_STORE_DIR / "jetstream"),
            "-p",
            str(fabric_port()),
            "--pid",
            str(_PID_FILE),
        ],
        stdout=log,
        stderr=log,
        start_new_session=True,  # survives this CLI process; `h events down` stops it by pidfile
    )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if fabric_running():
            return {"running": True, "url": EVENTS_URL, "pid": proc.pid, "started": True}
        if proc.poll() is not None:
            raise FabricError(
                f"nats-server exited immediately (code {proc.returncode}) — see {_LOG_FILE}"
            )
        time.sleep(0.1)
    raise FabricError(f"nats-server did not answer on {EVENTS_URL} within 5s — see {_LOG_FILE}")


def stop_server() -> bool:
    """SIGTERM by pidfile; True when a server was actually stopped."""
    pid = _server_pid()
    if pid is None:
        return False
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not fabric_running() and _server_pid() is None:
            return True
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)
    return True


async def connect() -> Any:
    try:
        return await nats.connect(EVENTS_URL, connect_timeout=3, max_reconnect_attempts=2)
    except Exception as err:
        raise FabricError(
            f"event fabric not reachable at {EVENTS_URL} — start it with `h events up`"
        ) from err


async def ensure_streams(js: Any) -> None:
    """Create the two streams when absent; an existing stream is left exactly as it is."""
    wanted = (
        StreamConfig(
            name=protocol.TASK_STREAM,
            subjects=[protocol.TASK_SUBJECTS],
            retention=RetentionPolicy.WORK_QUEUE,
            duplicate_window=DUPLICATE_WINDOW_SECONDS,
        ),
        StreamConfig(
            name=protocol.RESULT_STREAM,
            subjects=[protocol.RESULT_SUBJECTS],
            max_age=RESULT_MAX_AGE_SECONDS,
        ),
    )
    for config in wanted:
        try:
            await js.stream_info(config.name)
        except nats.js.errors.NotFoundError:
            await js.add_stream(config=config)


async def publish_task(js: Any, descriptor: dict[str, Any]) -> bool:
    """Publish a fire descriptor with its dedup identity; True when it was a rejected duplicate."""
    ack = await js.publish(
        protocol.task_subject(descriptor["queue"]),
        json.dumps(descriptor).encode(),
        headers={"Nats-Msg-Id": protocol.msg_id(descriptor)},
    )
    return bool(getattr(ack, "duplicate", False))


async def publish_result(js: Any, event: dict[str, Any]) -> None:
    await js.publish(protocol.result_subject(event["group"]), json.dumps(event).encode())


async def publish_seed(descriptor: dict[str, Any]) -> bool:
    """One-shot connect → ensure streams → publish → drain. The seam `h events publish` uses."""
    nc = await connect()
    try:
        js = nc.jetstream()
        await ensure_streams(js)
        return await publish_task(js, descriptor)
    finally:
        await nc.drain()


RelayHandler = Callable[[dict[str, Any]], tuple[dict[str, Any] | None, dict[str, Any] | None]]


async def relay(queue: str, handler: RelayHandler, emit: Callable[[str], None]) -> None:
    """The relay loop: consume `h.task.<queue>` durably, run each descriptor through `handler`
    (in a thread — it blocks on an agent CLI), then forward its hand-off and/or terminal event.

    Ordering is the crash-safety argument: publish-next and publish-result happen BEFORE the ack,
    so relay death at any point leaves either an unacked task (redelivered) or a published
    successor whose dedup id makes the redelivered step's re-publish a no-op. The ack is the
    LAST effect.
    """
    nc = await connect()
    try:
        js = nc.jetstream()
        await ensure_streams(js)
        psub = await js.pull_subscribe(
            protocol.task_subject(queue),
            durable=f"relay-{queue}",
            stream=protocol.TASK_STREAM,
            config=ConsumerConfig(ack_wait=ACK_WAIT_SECONDS, max_deliver=MAX_DELIVER),
        )
        emit(f"relay armed: {protocol.task_subject(queue)} (durable relay-{queue})")
        while True:
            try:
                msgs = await psub.fetch(1, timeout=10)
            except (TimeoutError, nats.errors.TimeoutError):
                continue
            msg = msgs[0]
            delivered = getattr(getattr(msg, "metadata", None), "num_delivered", 1) or 1
            try:
                descriptor = json.loads(msg.data)
            except json.JSONDecodeError as err:
                emit(f"✗ malformed task (not JSON: {err}) — terminated, no redelivery")
                await msg.term()
                continue
            problems = protocol.validate_descriptor(descriptor)
            if problems:
                emit(f"✗ invalid descriptor ({'; '.join(problems)}) — terminated")
                await msg.term()
                continue

            redelivery = " (redelivery)" if delivered > 1 else ""
            emit(
                f"→ step {descriptor['step']}/{descriptor['maxSteps']} "
                f"[{descriptor['group']}] agent={descriptor['agent']}{redelivery}"
            )

            async def heartbeat(message: Any) -> None:
                while True:
                    await asyncio.sleep(HEARTBEAT_SECONDS)
                    await message.in_progress()

            beat = asyncio.create_task(heartbeat(msg))
            try:
                next_descriptor, result = await asyncio.to_thread(handler, descriptor)
            finally:
                beat.cancel()

            if next_descriptor is not None:
                duplicate = await publish_task(js, next_descriptor)
                emit(
                    f"  ↪ handed off to step {next_descriptor['step']} "
                    f"(agent={next_descriptor['agent']})"
                    + (" — duplicate suppressed by dedup window" if duplicate else "")
                )
            if result is not None:
                await publish_result(js, result)
                emit(
                    f"  ■ terminal: {result['status']} → {protocol.result_subject(result['group'])}"
                )
            await msg.ack_sync()
    finally:
        await nc.close()


async def await_result(group: str, timeout: float) -> dict[str, Any] | None:
    """Block until `group`'s terminal envelope is readable, or `timeout` elapses.

    Deliberately an EPHEMERAL consumer replaying the stream from the start: a result that landed
    before this call — the seeder was busy, the driver's watch had lapsed, the loop finished in
    seconds — is still delivered, which is the whole difference from `tail`. Nothing durable is
    left behind, so awaiting a group is stateless and repeatable.
    """
    nc = await connect()
    try:
        js = nc.jetstream()
        await ensure_streams(js)
        psub = await js.pull_subscribe(
            protocol.result_subject(group),
            stream=protocol.RESULT_STREAM,
            config=ConsumerConfig(deliver_policy=DeliverPolicy.ALL),
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                msgs = await psub.fetch(1, timeout=min(5, max(1, deadline - time.monotonic())))
            except (TimeoutError, nats.errors.TimeoutError):
                continue
            for msg in msgs:
                await msg.ack()
                try:
                    return json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
        return None
    finally:
        await nc.close()


async def consume_results(
    durable: str,
    group: str | None,
    emit: Callable[[dict[str, Any]], None],
) -> None:
    """Stream terminal envelopes off a DURABLE consumer, acking each — the driver's back-edge.

    Durable because a driver watches in bursts: between turns, or across a monitor that timed out,
    results keep landing and must still be there. The consumer resumes exactly where its last ack
    left it, so nothing is delivered twice and nothing is missed — the property a live `tail`
    cannot offer.
    """
    nc = await connect()
    try:
        js = nc.jetstream()
        await ensure_streams(js)
        psub = await js.pull_subscribe(
            protocol.result_subject(group) if group else protocol.RESULT_SUBJECTS,
            durable=durable,
            stream=protocol.RESULT_STREAM,
            config=ConsumerConfig(ack_wait=ACK_WAIT_SECONDS),
        )
        while True:
            try:
                msgs = await psub.fetch(1, timeout=10)
            except (TimeoutError, nats.errors.TimeoutError):
                continue
            for msg in msgs:
                try:
                    event = json.loads(msg.data)
                except json.JSONDecodeError:
                    await msg.term()  # unparseable history must not wedge the consumer
                    continue
                emit(event)
                await msg.ack_sync()
    finally:
        await nc.close()


async def watch(subject: str, emit: Callable[[str, dict[str, Any] | str], None]) -> None:
    """Live core-NATS subscription — the observability tail, deliberately not a consumer (it takes
    nothing from the work queue)."""
    nc = await connect()
    try:
        sub = await nc.subscribe(subject)
        emit(subject, "…listening (Ctrl-C to stop)")
        async for msg in sub.messages:
            try:
                emit(msg.subject, json.loads(msg.data))
            except json.JSONDecodeError:
                emit(msg.subject, msg.data.decode(errors="replace"))
    finally:
        await nc.close()


async def stream_report() -> list[dict[str, Any]]:
    """Per-stream message counts + the relay consumers — the `h events status` body."""
    nc = await connect()
    try:
        js = nc.jetstream()
        report: list[dict[str, Any]] = []
        for name in (protocol.TASK_STREAM, protocol.RESULT_STREAM):
            try:
                info = await js.stream_info(name)
            except nats.js.errors.NotFoundError:
                report.append({"stream": name, "present": False})
                continue
            row: dict[str, Any] = {
                "stream": name,
                "present": True,
                "messages": info.state.messages,
                "subjects": list(info.config.subjects or []),
            }
            consumers = []
            try:
                for consumer in await js.consumers_info(name):
                    consumers.append(
                        {
                            "name": consumer.name,
                            "pending": consumer.num_pending,
                            "inFlight": consumer.num_ack_pending,
                        }
                    )
            except nats.js.errors.Error:
                pass
            if consumers:
                row["consumers"] = consumers
            report.append(row)
        return report
    finally:
        await nc.close()


def store_paths() -> dict[str, Path]:
    return {"store": EVENTS_STORE_DIR, "pid": _PID_FILE, "log": _LOG_FILE}
