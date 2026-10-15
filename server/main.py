from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from server.api.router import api_router
from server.config import get_settings
from server.services.analysis_queue import AnalysisTaskQueue
from server.services.anonymous_session import AnonymousSessionMiddleware
from server.services.mix_jobs import MixJobs
from server.storage.job_store import JobStore


@asynccontextmanager
async def lifespan(application: FastAPI):
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    (settings.data_dir / "jobs").mkdir(exist_ok=True)
    (settings.data_dir / "songs").mkdir(exist_ok=True)
    job_store = JobStore(settings.data_dir)
    job_store.recover_interrupted_jobs()
    analysis_queue = AnalysisTaskQueue(job_store)
    analysis_queue.start()
    application.state.analysis_queue = analysis_queue
    application.state.mix_jobs = MixJobs(settings.data_dir, settings.ffmpeg_executable)
    try:
        yield
    finally:
        await application.state.mix_jobs.stop()
        await analysis_queue.stop()


settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
app.add_middleware(
    AnonymousSessionMiddleware,
    data_dir=settings.data_dir,
    secure=settings.environment == "production",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router, prefix=settings.api_prefix)


class SpaStaticFiles(StaticFiles):
    """Serve the built H5 and fall back to index.html for client-side routes."""

    async def get_response(self, path: str, scope: dict) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code != 404 or "." in Path(path).name:
            return response
        index = Path(self.directory) / "index.html"
        return FileResponse(index) if index.is_file() else response


if settings.web_dist_dir.is_dir():
    app.mount(
        "/",
        SpaStaticFiles(directory=settings.web_dist_dir, html=True),
        name="web",
    )
else:
    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {"name": settings.app_name, "docs": "/docs"}

