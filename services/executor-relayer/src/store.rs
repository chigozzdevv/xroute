use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{create_dir_all, read_to_string, rename, write};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use xroute_service_shared::DispatchRequest;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobType {
    Dispatch,
    Settle,
    Fail,
    Refund,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobPayload {
    Dispatch {
        intent_id: String,
        request: DispatchRequest,
    },
    Settle {
        intent_id: String,
        outcome_reference: String,
        result_asset_id: String,
        result_amount: String,
    },
    Fail {
        intent_id: String,
        outcome_reference: String,
        failure_reason_hash: String,
    },
    Refund {
        intent_id: String,
        refund_amount: String,
        refund_asset: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    #[serde(rename = "type")]
    pub job_type: JobType,
    pub status: JobStatus,
    pub attempts: u32,
    pub max_attempts: u32,
    pub created_at: u64,
    pub updated_at: u64,
    pub next_attempt_at: Option<u64>,
    pub payload: JobPayload,
    pub result: Option<Value>,
    pub last_error: Option<String>,
    pub completed_at: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreSnapshot {
    jobs: BTreeMap<String, Job>,
}

pub struct JobStore {
    path: PathBuf,
    jobs: Mutex<BTreeMap<String, Job>>,
}

impl JobStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let jobs = if path.exists() {
            let raw = read_to_string(&path).map_err(|error| {
                format!("failed to read job store {}: {error}", path.display())
            })?;
            serde_json::from_str::<StoreSnapshot>(&raw)
                .map_err(|error| format!("invalid job store {}: {error}", path.display()))?
                .jobs
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            path,
            jobs: Mutex::new(jobs),
        })
    }

    pub async fn list(&self) -> Vec<Job> {
        self.jobs.lock().await.values().cloned().collect()
    }

    pub async fn get(&self, job_id: &str) -> Option<Job> {
        self.jobs.lock().await.get(job_id).cloned()
    }

    pub async fn upsert(&self, job: Job) -> Result<Job, String> {
        let mut jobs = self.jobs.lock().await;
        jobs.insert(job.id.clone(), job.clone());
        persist_snapshot(&self.path, &jobs)?;
        Ok(job)
    }
}

fn persist_snapshot(path: &Path, jobs: &BTreeMap<String, Job>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)
            .map_err(|error| format!("failed to create job store directory {}: {error}", parent.display()))?;
    }

    let snapshot = StoreSnapshot { jobs: jobs.clone() };
    let raw = serde_json::to_string_pretty(&snapshot)
        .map_err(|error| format!("failed to encode job store: {error}"))?;
    let temp_path = path.with_extension("tmp");
    write(&temp_path, format!("{raw}\n"))
        .map_err(|error| format!("failed to write job store {}: {error}", temp_path.display()))?;
    rename(&temp_path, path).map_err(|error| {
        format!(
            "failed to move job store {} into place: {error}",
            temp_path.display()
        )
    })?;
    Ok(())
}
