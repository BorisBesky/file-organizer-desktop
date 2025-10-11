use anyhow::{anyhow, Result};
use llama_cpp::{LlamaModel, LlamaParams, SessionParams};
use llama_cpp::standard_sampler::StandardSampler;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedModelConfig {
    pub model_path: String,
    pub context_length: Option<u32>,
    pub gpu_layers: Option<u32>,
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedInferenceArgs {
    pub prompt: String,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedInferenceResult {
    pub content: String,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
}

struct EmbeddedModel {
    model_path: String,
    model: LlamaModel,
    config: EmbeddedModelConfig,
}

impl EmbeddedModel {
    fn new(config: &EmbeddedModelConfig) -> Result<Self> {
        let path = Path::new(&config.model_path);
        if !path.exists() {
            return Err(anyhow!("Model file not found at {}", config.model_path));
        }

        let params = LlamaParams {
            n_gpu_layers: config.gpu_layers.unwrap_or(0),
            ..Default::default()
        };

        let model = LlamaModel::load_from_file(&config.model_path, params)?;
        eprintln!("Model loaded successfully");
        eprintln!("Model path: {}", config.model_path);
        eprintln!("Model context length: {}", config.context_length.unwrap_or(4096));
        eprintln!("Model gpu layers: {}", config.gpu_layers.unwrap_or(0));
        eprintln!("Model seed: {}", config.seed.unwrap_or(0));

        Ok(Self {
            model_path: config.model_path.clone(),
            model,
            config: config.clone()
        })
    }

    fn infer(&mut self, args: &EmbeddedInferenceArgs) -> Result<EmbeddedInferenceResult> {
        // Use very small context length for CPU inference (512 max)
        let context_length = if self.config.gpu_layers.unwrap_or(0) >= 33 {self.config.context_length.unwrap_or(4096)} else {512};
        
        // For file classification, each inference is independent - always create fresh session
        // This prevents context accumulation across files (each file should be classified independently)
        // Note: GGML will show allocation messages when creating sessions - this is normal behavior
        // The model weights stay loaded in memory; only the session buffers are reallocated
        let session_params = SessionParams {
            n_ctx: context_length,
            ..Default::default()
        };
        let mut session = self.model.create_session(session_params)?;
        
        let prompt = &args.prompt;
        let max_prompt_chars = if self.config.gpu_layers.unwrap_or(0) >= 33 {prompt.len()} else {400};

        let truncated_prompt = if max_prompt_chars > prompt.len() {
            &prompt[..max_prompt_chars]
        } else {
            &prompt[..]
        };

        session.advance_context(truncated_prompt)?;

        // File classification only needs ~100 tokens for JSON response
        // Use reasonable defaults: 150 max for GPU, 50 for CPU
        let max_tokens = if self.config.gpu_layers.unwrap_or(0) >= 33 {
            args.max_tokens.unwrap_or(150).min(150)
        } else {
            args.max_tokens.unwrap_or(50).min(50)
        };
        
        let sampler = StandardSampler::default();

        // Start generating tokens
        let mut completion = session.start_completing_with(sampler, max_tokens as usize)?;
        let mut content = String::new();
        let mut decoded_tokens = 0;

        // Add timeout to prevent infinite loops (5 seconds should be plenty for 150 tokens on GPU)
        let start_time = Instant::now();
        let timeout = Duration::from_secs(5);

        // Generate tokens - no artificial delays, let GPU work efficiently
        while let Some(token) = completion.next() {
            // Check timeout
            if start_time.elapsed() > timeout {
                eprintln!("Inference timeout after {} tokens ({}s)", decoded_tokens, timeout.as_secs());
                break;
            }

            let token_str = self.model.token_to_piece(token);
            content.push_str(&token_str);
            decoded_tokens += 1;

            if decoded_tokens >= max_tokens {
                break;
            }
        }

        Ok(EmbeddedInferenceResult {
            content,
            prompt_tokens: session.context().len(),
            completion_tokens: decoded_tokens as usize,
        })
    }
}

static EMBEDDED_MODEL: OnceCell<Arc<Mutex<EmbeddedModel>>> = OnceCell::new();

pub fn ensure_model(config: EmbeddedModelConfig) -> Result<()> {
    if EMBEDDED_MODEL.get().is_none() {
        let model = EmbeddedModel::new(&config)?;
        let shared = Arc::new(Mutex::new(model));
        // Ignore failure if another thread beat us to initialization.
        let _ = EMBEDDED_MODEL.set(shared);
    }

    let cell = EMBEDDED_MODEL
        .get()
        .ok_or_else(|| anyhow!("Embedded model failed to initialize"))?;

    let current_path = {
        let model = cell.lock();
        model.model_path.clone()
    };

    if current_path != config.model_path {
        let mut lock = cell.lock();
        *lock = EmbeddedModel::new(&config)?;
    }

    Ok(())
}

pub fn infer(args: EmbeddedInferenceArgs) -> Result<EmbeddedInferenceResult> {
    let model = EMBEDDED_MODEL
        .get()
        .ok_or_else(|| anyhow!("Embedded model not initialized"))?
        .clone();

    let mut guard = model.lock();
    guard.infer(&args)
}
