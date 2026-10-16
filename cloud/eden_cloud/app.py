"""Eden Cloud's HTTP API (docs: cloud/README.md, "API"). JSON in and out, errors as
{"error": "<words for a person>", "code": "<machine code>"} like askeden.com's.

The Mac's side (an Eden Cloud token, auth.py):
    GET    /v1/health                        → {ok, version, backend}
    GET    /v1/me                            → {account, plan, limits, usage}
    GET    /v1/runs                          → {runs: [...]}
    POST   /v1/runs                          → 201 run   {brief, model?, budget_usd?, max_minutes?,
                                                         title?, anthropic_key, source}
    PUT    /v1/runs/<id>/source              → run       (a git bundle, for source.kind "bundle")
    GET    /v1/runs/<id>                     → run
    GET    /v1/runs/<id>/events?after=N&wait=S → {run, events: [{seq, line}]}  (waits up to S≤25 s)
    POST   /v1/runs/<id>/cancel              → run
    GET    /v1/runs/<id>/result              → the result bundle (404 until there is one)
    GET    /v1/runs/<id>/diff                → the diff, text
    DELETE /v1/runs/<id>                     → 204 (cancelled if running; everything deleted)

The runner's side (its one-run token, only while the run is live):
    GET  /v1/runner/<id>/job     GET  /v1/runner/<id>/source    POST /v1/runner/<id>/events
    PUT  /v1/runner/<id>/result  PUT  /v1/runner/<id>/diff      POST /v1/runner/<id>/done
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import __version__, backends
from .auth import AuthError, Verifier
from .config import Settings
from .service import Service, ServiceError
from .store import Store

log = logging.getLogger("eden_cloud")
WAIT_MAX = 25.0


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=status)


async def read_body(request: Request, cap: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise ServiceError(413, "too_big", "That's more than Eden Cloud takes.")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > cap:
            raise ServiceError(413, "too_big", "That's more than Eden Cloud takes.")
        chunks.append(chunk)
    return b"".join(chunks)


async def read_json(request: Request, cap: int = 256 * 1024) -> dict[str, Any]:
    try:
        body = json.loads(await read_body(request, cap) or b"{}")
    except ValueError:
        raise ServiceError(400, "bad_request", "That isn't JSON.") from None
    if not isinstance(body, dict):
        raise ServiceError(400, "bad_request", "That isn't a JSON object.")
    return body


def build(
    settings: Settings,
    backend: backends.Backend | None = None,
    verifier: Verifier | None = None,
    watch: bool = True,
    clock=None,
) -> Starlette:
    problems = settings.problems()
    if problems:
        raise RuntimeError("Eden Cloud can't start: " + " ".join(problems))
    store = Store(settings.data_dir)
    backend = backend or backends.make(settings)
    kw = {"clock": clock} if clock else {}
    service = Service(settings, store, backend, **kw)
    verifier = verifier or Verifier(
        settings.askeden_public_key, settings.token_issuer, settings.dev_tokens, **kw
    )

    def handler(fn):
        async def endpoint(request: Request) -> Response:
            try:
                return await fn(request)
            except (AuthError, ServiceError) as exc:
                return error(exc.status, exc.code, exc.message)
            except Exception:
                log.exception("request failed: %s %s", request.method, request.url.path)
                return error(500, "error", "Something went wrong in Eden Cloud.")

        return endpoint

    def user(request: Request) -> Any:
        return verifier.verify(request.headers.get("authorization", ""))

    # ── the Mac's side ──

    async def health(_request: Request) -> Response:
        return JSONResponse({"ok": True, "version": __version__, "backend": backend.name})

    async def me(request: Request) -> Response:
        u = user(request)
        service.may_use(u)
        return JSONResponse(
            {
                "account": u.account,
                "plan": u.plan,
                "limits": service.limits(),
                "usage": service.usage(u.account),
            }
        )

    async def runs(request: Request) -> Response:
        u = user(request)
        if request.method == "POST":
            run = await service.create(
                u, await read_json(request, settings.max_brief_chars * 4 + 8192)
            )
            return JSONResponse(run.public(), status_code=201)
        return JSONResponse({"runs": [r.public() for r in store.of_account(u.account)]})

    async def run_one(request: Request) -> Response:
        u = user(request)
        run_id = request.path_params["id"]
        if request.method == "DELETE":
            await service.delete(u, run_id)
            return Response(status_code=204)
        return JSONResponse(service.owned(u, run_id).public())

    async def source(request: Request) -> Response:
        u = user(request)
        service.owned(u, request.path_params["id"])  # (before reading its bytes)
        data = await read_body(request, settings.max_source_mb << 20)
        run = await service.put_source(u, request.path_params["id"], data)
        return JSONResponse(run.public())

    async def events(request: Request) -> Response:
        u = user(request)
        run_id = request.path_params["id"]
        try:
            after = max(0, int(request.query_params.get("after") or 0))
            wait = min(WAIT_MAX, max(0.0, float(request.query_params.get("wait") or 0)))
        except ValueError:
            raise ServiceError(400, "bad_request", "after and wait are numbers.") from None
        run = service.owned(u, run_id)
        found = store.events_after(run_id, after)
        if not found and not run.terminal and wait:
            await service.wait(run_id, wait)
            run = service.owned(u, run_id)
            found = store.events_after(run_id, after)
        return JSONResponse(
            {"run": run.public(), "events": [{"seq": s, "line": line} for s, line in found]}
        )

    async def cancel(request: Request) -> Response:
        run = await service.cancel(user(request), request.path_params["id"])
        return JSONResponse(run.public())

    def file_of(request: Request, name: str, kind: str) -> Response:
        run = service.owned(user(request), request.path_params["id"])
        path = store.dir(run.id) / name
        if not path.is_file():
            raise ServiceError(404, "not_found", "There's no result for this run (yet).")
        return Response(path.read_bytes(), media_type=kind)

    async def result(request: Request) -> Response:
        return file_of(request, "result.bundle", "application/octet-stream")

    async def diff(request: Request) -> Response:
        return file_of(request, "diff.patch", "text/plain; charset=utf-8")

    # ── the runner's side ──

    def runner(request: Request):
        return service.runner(request.path_params["id"], request.headers.get("authorization", ""))

    async def r_job(request: Request) -> Response:
        return JSONResponse(service.job(runner(request)))

    async def r_source(request: Request) -> Response:
        run = runner(request)
        path = store.dir(run.id) / "source.bundle"
        if run.source_kind != "bundle" or not path.is_file():
            raise ServiceError(404, "not_found", "This run has no bundle.")
        return Response(path.read_bytes(), media_type="application/octet-stream")

    async def r_events(request: Request) -> Response:
        run = runner(request)
        data = await read_body(request, 8 << 20)
        lines = data.decode("utf-8", errors="replace").splitlines()
        seq = await service.add_events(run, lines)
        stop = service.store.get(run.id)
        return JSONResponse({"seq": seq, "stop": bool(stop is None or stop.terminal)})

    async def r_put(request: Request, name: str) -> Response:
        run = runner(request)
        data = await read_body(request, settings.max_result_mb << 20)
        service.put_result(run, name, data)
        return Response(status_code=204)

    async def r_result(request: Request) -> Response:
        return await r_put(request, "result.bundle")

    async def r_diff(request: Request) -> Response:
        return await r_put(request, "diff.patch")

    async def r_done(request: Request) -> Response:
        run = await service.done(runner(request), await read_json(request))
        return JSONResponse({"state": run.state})

    routes = [
        Route("/v1/health", handler(health), methods=["GET"]),
        Route("/v1/me", handler(me), methods=["GET"]),
        Route("/v1/runs", handler(runs), methods=["GET", "POST"]),
        Route("/v1/runs/{id}", handler(run_one), methods=["GET", "DELETE"]),
        Route("/v1/runs/{id}/source", handler(source), methods=["PUT"]),
        Route("/v1/runs/{id}/events", handler(events), methods=["GET"]),
        Route("/v1/runs/{id}/cancel", handler(cancel), methods=["POST"]),
        Route("/v1/runs/{id}/result", handler(result), methods=["GET"]),
        Route("/v1/runs/{id}/diff", handler(diff), methods=["GET"]),
        Route("/v1/runner/{id}/job", handler(r_job), methods=["GET"]),
        Route("/v1/runner/{id}/source", handler(r_source), methods=["GET"]),
        Route("/v1/runner/{id}/events", handler(r_events), methods=["POST"]),
        Route("/v1/runner/{id}/result", handler(r_result), methods=["PUT"]),
        Route("/v1/runner/{id}/diff", handler(r_diff), methods=["PUT"]),
        Route("/v1/runner/{id}/done", handler(r_done), methods=["POST"]),
    ]

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette):
        task = asyncio.create_task(service.watch()) if watch else None
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await backend.aclose()

    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.service = service
    app.state.store = store
    app.state.backend = backend
    return app
