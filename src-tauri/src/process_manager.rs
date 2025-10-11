use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::embedded_llm::{EmbeddedInferenceArgs, EmbeddedModelConfig};
use crate::embedded_llm_service::{
    spawn_service, DownloadRequest, DownloadResponse, ErrorResponse, InferRequest, InferResponse, LoadRequest,
    LoadResponse, ServiceHandle, ServiceInfo, StatusResponse,
};

static SERVICE_MANAGER: Lazy<Mutex<ServiceManager>> = Lazy::new(|| Mutex::new(ServiceManager::default()));

#[derive(Default)]
struct ServiceManager {
    service: Option<ManagedService>,
}

struct ManagedService {
    #[allow(dead_code)]
    handle: ServiceHandle,
    info: ServiceInfo,
    client: reqwest::Client,
}

impl ManagedService {
    fn base_url(&self) -> String {
        format!("http://{}", self.info.addr)
    }

    fn info(&self) -> ServiceInfo {
        self.info
    }
}

#[derive(Debug, Clone)]
pub struct ServiceSnapshot {
    pub base_url: String,
    pub status: StatusResponse,
}

pub async fn ensure_service() -> Result<ServiceInfo> {
    if let Some(info) = current_info().await {
        return Ok(info);
    }

    let (handle, _state) = spawn_service().await?;
    let info = handle.info();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .context("Failed to build HTTP client for embedded LLM service")?;

    let mut guard = SERVICE_MANAGER.lock().await;
    if let Some(existing) = guard.service.as_ref() {
        return Ok(existing.info());
    }

    guard.service = Some(ManagedService { handle, info, client });
    Ok(info)
}

pub async fn snapshot() -> Result<ServiceSnapshot> {
    let (client, base_url) = client_and_base_url().await?;
    let payload = serde_json::json!({});
    let status: StatusResponse = post_json(&client, &format!("{}/status", base_url), &payload).await?;
    Ok(ServiceSnapshot { base_url, status })
}

pub async fn load_model(config: EmbeddedModelConfig) -> Result<LoadResponse> {
    let (client, base_url) = client_and_base_url().await?;
    post_json(&client, &format!("{}/load", base_url), &LoadRequest { config }).await
}

pub async fn infer(args: EmbeddedInferenceArgs) -> Result<InferResponse> {
    let (client, base_url) = client_and_base_url().await?;
    post_json(&client, &format!("{}/infer", base_url), &InferRequest { args }).await
}

pub async fn download_model(request: DownloadRequest) -> Result<DownloadResponse> {
    let (client, base_url) = client_and_base_url().await?;
    post_json(&client, &format!("{}/download", base_url), &request).await
}

async fn client_and_base_url() -> Result<(reqwest::Client, String)> {
    ensure_service().await?;
    let guard = SERVICE_MANAGER.lock().await;
    let service = guard
        .service
        .as_ref()
        .ok_or_else(|| anyhow!("Embedded service not initialized after ensure"))?;
    Ok((service.client.clone(), service.base_url()))
}

async fn current_info() -> Option<ServiceInfo> {
    let guard = SERVICE_MANAGER.lock().await;
    guard.service.as_ref().map(|service| service.info())
}

async fn post_json<T, R>(
    client: &reqwest::Client,
    url: &str,
    payload: &T,
) -> Result<R>
where
    T: Serialize + ?Sized,
    R: DeserializeOwned,
{
    let response = client
        .post(url)
        .json(payload)
        .send()
        .await
        .with_context(|| format!("Failed to call {}", url))?;

    parse_response(response).await
}

async fn parse_response<T>(response: reqwest::Response) -> Result<T>
where
    T: DeserializeOwned,
{
    let status = response.status();
    if status.is_success() {
        return response
            .json::<T>()
            .await
            .context("Failed to parse embedded service response body");
    }

    let text = response.text().await.unwrap_or_default();
    if let Ok(err) = serde_json::from_str::<ErrorResponse>(&text) {
        Err(anyhow!("Embedded service error ({}): {}", status, err.error))
    } else if text.is_empty() {
        Err(anyhow!("Embedded service responded with status {}", status))
    } else {
        Err(anyhow!("Embedded service responded with status {}: {}", status, text))
    }
}
