use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio::task;

use crate::embedded_llm::{self, EmbeddedInferenceArgs, EmbeddedInferenceResult, EmbeddedModelConfig};

#[derive(Clone)]
pub struct ServiceState {
    inner: Arc<InnerState>,
}

struct InnerState {
    start_time: Instant,
    model: Mutex<Option<ModelState>>,
    downloads: Mutex<Vec<DownloadState>>,
}

#[derive(Clone)]
struct ModelState {
    path: String,
    #[allow(dead_code)]
    last_loaded: Instant,
    #[allow(dead_code)]
    context_length: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadState {
    pub id: String,
    pub url: String,
    pub target_path: String,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub status: DownloadStatus,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl ServiceState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(InnerState {
                start_time: Instant::now(),
                model: Mutex::new(None),
                downloads: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn started_at(&self) -> Instant {
        self.inner.start_time
    }

    pub fn uptime_s(&self) -> u64 {
        self.inner.start_time.elapsed().as_secs()
    }

    pub async fn record_model(&self, path: String, context_length: Option<u32>) {
        let mut guard = self.inner.model.lock().await;
        *guard = Some(ModelState {
            path,
            last_loaded: Instant::now(),
            context_length,
        });
    }

    pub async fn model_snapshot(&self) -> (bool, Option<String>) {
        let guard = self.inner.model.lock().await;
        match guard.as_ref() {
            Some(model) => (true, Some(model.path.clone())),
            None => (false, None),
        }
    }

    pub async fn register_download(&self, download: DownloadState) {
        let mut guard = self.inner.downloads.lock().await;
        guard.push(download);
    }

    pub async fn update_download<F>(&self, id: &str, mut f: F)
    where
        F: FnMut(&mut DownloadState),
    {
        let mut guard = self.inner.downloads.lock().await;
        if let Some(item) = guard.iter_mut().find(|d| d.id == id) {
            f(item);
        }
    }

    pub async fn downloads(&self) -> Vec<DownloadState> {
        self.inner.downloads.lock().await.clone()
    }

    pub async fn ensure_ready(&self) -> Result<()> {
        let guard = self.inner.model.lock().await;
        if guard.is_some() {
            Ok(())
        } else {
            Err(anyhow::anyhow!("No embedded model loaded"))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusResponse {
    pub ready: bool,
    pub model: Option<String>,
    pub uptime_s: u64,
    pub downloads: Vec<DownloadState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadRequest {
    pub config: EmbeddedModelConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadStats {
    pub load_ms: u128,
    pub context_length: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadResponse {
    pub loaded: bool,
    pub model_path: String,
    pub stats: LoadStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferRequest {
    pub args: EmbeddedInferenceArgs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferResponse {
    pub content: String,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub latency_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub url: String,
    pub target_name: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadResponse {
    pub id: String,
    pub started: bool,
}

type ServiceResult<T> = Result<Json<T>, (StatusCode, Json<ErrorResponse>)>;

pub struct ServiceHandle {
    info: ServiceInfo,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Clone, Copy)]
pub struct ServiceInfo {
    pub addr: SocketAddr,
    #[allow(dead_code)]
    pub started_at: Instant,
}

impl ServiceHandle {
    fn new(
        addr: SocketAddr,
        started_at: Instant,
        shutdown_tx: oneshot::Sender<()>,
        join_handle: tauri::async_runtime::JoinHandle<()>,
    ) -> Self {
        Self {
            info: ServiceInfo { addr, started_at },
            shutdown_tx: Some(shutdown_tx),
            join_handle: Some(join_handle),
        }
    }

    pub fn info(&self) -> ServiceInfo {
        self.info
    }
}

impl Drop for ServiceHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            handle.abort();
        }
    }
}

pub async fn spawn_service() -> Result<(ServiceHandle, ServiceState)> {
    let state = ServiceState::new();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("Failed to bind embedded LLM service socket")?;
    let addr = listener
        .local_addr()
        .context("Unable to read local address for embedded LLM service")?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let router = Router::new()
        .route("/status", post(status_handler))
        .route("/load", post(load_handler))
        .route("/infer", post(infer_handler))
        .route("/download", post(download_handler))
        .with_state(state.clone());

    let server = axum::serve(listener, router).with_graceful_shutdown(async move {
        let _ = shutdown_rx.await;
    });

    let join_handle = tauri::async_runtime::spawn(async move {
        if let Err(err) = server.await {
            eprintln!("Embedded LLM service exited with error: {err}");
        }
    });

    let handle = ServiceHandle::new(addr, state.started_at(), shutdown_tx, join_handle);
    Ok((handle, state))
}

async fn status_handler(State(state): State<ServiceState>) -> Json<StatusResponse> {
    let (ready, model) = state.model_snapshot().await;
    Json(StatusResponse {
        ready,
        model,
        uptime_s: state.uptime_s(),
        downloads: state.downloads().await,
    })
}

async fn load_handler(
    State(state): State<ServiceState>,
    Json(request): Json<LoadRequest>,
) -> ServiceResult<LoadResponse> {
    let config_for_load = request.config.clone();
    let model_path = request.config.model_path.clone();
    let context_length = request.config.context_length;

    let load_start = Instant::now();
    task::spawn_blocking(move || embedded_llm::ensure_model(config_for_load))
        .await
        .map_err(|err| internal_error(format!("Failed to join load task: {err}")))?
        .map_err(|err| internal_error(err.to_string()))?;

    let load_ms = load_start.elapsed().as_millis();
    state
        .record_model(model_path.clone(), context_length)
        .await;

    Ok(Json(LoadResponse {
        loaded: true,
        model_path,
        stats: LoadStats {
            load_ms,
            context_length,
        },
    }))
}

async fn infer_handler(
    State(state): State<ServiceState>,
    Json(request): Json<InferRequest>,
) -> ServiceResult<InferResponse> {
    if let Err(err) = state.ensure_ready().await {
        return Err((StatusCode::BAD_REQUEST, Json(ErrorResponse { error: err.to_string() })));
    }

    let args = request.args.clone();
    let infer_start = Instant::now();

    let result: EmbeddedInferenceResult = task::spawn_blocking(move || embedded_llm::infer(args))
        .await
        .map_err(|err| internal_error(format!("Failed to join infer task: {err}")))?
        .map_err(|err| internal_error(err.to_string()))?;

    Ok(Json(InferResponse {
        content: result.content,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        latency_ms: infer_start.elapsed().as_millis(),
    }))
}

async fn download_handler(
    State(state): State<ServiceState>,
    Json(request): Json<DownloadRequest>,
) -> ServiceResult<DownloadResponse> {
    let download_id = uuid::Uuid::new_v4().to_string();
    let default_name = request
        .target_name
        .clone()
        .unwrap_or_else(|| format!("model-{}.gguf", &download_id[..8]));
    let target_path = default_model_dir().join(&default_name);

    let initial_state = DownloadState {
        id: download_id.clone(),
        url: request.url.clone(),
        target_path: target_path.to_string_lossy().to_string(),
        bytes_downloaded: 0,
        total_bytes: None,
        status: DownloadStatus::Pending,
        error: None,
    };

    state.register_download(initial_state.clone()).await;

    let task_state = state.clone();
    let task_id = download_id.clone();
    let task_url = request.url.clone();
    let task_target = target_path.clone();
    let task_sha = request.sha256.clone();
    task::spawn(async move {
        if let Err(err) = perform_download(task_state.clone(), task_id.clone(), task_url, task_target, task_sha).await {
            let message = err.to_string();
            task_state
                .update_download(&task_id, |entry| {
                    entry.status = DownloadStatus::Failed;
                    entry.error = Some(message.clone());
                })
                .await;
        }
    });

    Ok(Json(DownloadResponse {
        id: download_id,
        started: true,
    }))
}

async fn perform_download(
    state: ServiceState,
    id: String,
    url: String,
    target_path: PathBuf,
    expected_sha256: Option<String>,
) -> Result<()> {
    let client = reqwest::Client::new();
    let response = client.get(&url).send().await.context("Failed to start download")?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!("Download failed with status {}", response.status()));
    }

    let total_bytes = response.content_length();
    state
        .update_download(&id, |entry| {
            entry.status = DownloadStatus::InProgress;
            entry.total_bytes = total_bytes;
        })
        .await;

    let mut file = open_target(&target_path).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Failed to read download chunk")?;
        file
            .write_all(&chunk)
            .await
            .context("Failed to write to download file")?;
        downloaded += chunk.len() as u64;

        state
            .update_download(&id, |entry| {
                entry.bytes_downloaded = downloaded;
            })
            .await;
    }

    file.flush().await.context("Failed to flush download file")?;

    if let Some(expected) = expected_sha256 {
        let path_clone = target_path.clone();
        task::spawn_blocking(move || verify_sha256(&path_clone, &expected))
            .await
            .map_err(|err| anyhow::anyhow!("Checksum task failed: {err}"))??;
    }

    state
        .update_download(&id, |entry| {
            entry.status = DownloadStatus::Completed;
        })
        .await;

    Ok(())
}

async fn open_target(path: &PathBuf) -> Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .context("Failed to create model directory")?;
    }
    File::create(path)
        .await
        .context("Failed to create download file")
}

fn verify_sha256(path: &PathBuf, expected: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    use std::fs::File as StdFile;
    use std::io::Read;

    let mut file = StdFile::open(path).context("Failed to open file for checksum validation")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer).context("Failed to read file for checksum")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected.to_lowercase() {
        return Err(anyhow::anyhow!(
            "Checksum mismatch: expected {} but found {}",
            expected,
            actual
        ));
    }
    Ok(())
}

fn default_model_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".file-organizer")
        .join("models")
}

// No event emission for now; front-end polls status for download updates.

fn internal_error<E: std::fmt::Display>(err: E) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: err.to_string(),
        }),
    )
}
