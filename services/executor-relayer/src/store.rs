use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{create_dir_all, read_to_string, rename, write};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use xroute_service_shared::{
    DispatchRequest, SourceDispatchMetadata, SourceIntentMetadata, WireIntent,
};

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
#[serde(rename_all = "kebab-case")]
pub enum SourceIntentStatus {
    Submitted,
    Dispatched,
    Settled,
    Failed,
    Refunded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobPayload {
    Dispatch {
        intent_id: String,
        wire_intent: WireIntent,
        request: DispatchRequest,
        source_intent: Option<SourceIntentMetadata>,
        source_dispatch: Option<SourceDispatchMetadata>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceIntentRecord {
    pub intent_id: String,
    pub source_chain: String,
    pub kind: String,
    pub refund_asset: String,
    pub refundable_amount: String,
    pub min_output_amount: String,
    pub status: SourceIntentStatus,
    pub dispatch_tx_hash: Option<String>,
    pub dispatch_strategy: Option<String>,
    pub outcome_reference: Option<String>,
    pub result_asset_id: Option<String>,
    pub result_amount: Option<String>,
    pub failure_reason_hash: Option<String>,
    pub refund_amount: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreSnapshot {
    jobs: BTreeMap<String, Job>,
    #[serde(default)]
    source_intents: BTreeMap<String, SourceIntentRecord>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LegacyStoreSnapshot {
    jobs: BTreeMap<String, Job>,
}

pub struct JobStore {
    path: PathBuf,
    snapshot: Mutex<StoreSnapshot>,
}

impl JobStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let snapshot = if path.exists() {
            let raw = read_to_string(&path)
                .map_err(|error| format!("failed to read job store {}: {error}", path.display()))?;
            match serde_json::from_str::<StoreSnapshot>(&raw) {
                Ok(snapshot) => snapshot,
                Err(_) => {
                    let legacy = serde_json::from_str::<LegacyStoreSnapshot>(&raw).map_err(|error| {
                        format!("invalid job store {}: {error}", path.display())
                    })?;
                    StoreSnapshot {
                        jobs: legacy.jobs,
                        source_intents: BTreeMap::new(),
                    }
                }
            }
        } else {
            StoreSnapshot::default()
        };

        Ok(Self {
            path,
            snapshot: Mutex::new(snapshot),
        })
    }

    pub async fn list(&self) -> Vec<Job> {
        self.snapshot.lock().await.jobs.values().cloned().collect()
    }

    pub async fn get(&self, job_id: &str) -> Option<Job> {
        self.snapshot.lock().await.jobs.get(job_id).cloned()
    }

    pub async fn dispatch_source_chain(&self, intent_id: &str) -> Option<String> {
        let snapshot = self.snapshot.lock().await;
        snapshot
            .source_intents
            .get(intent_id)
            .map(|record| record.source_chain.clone())
            .or_else(|| {
                snapshot.jobs.values().find_map(|job| match &job.payload {
                    JobPayload::Dispatch {
                        intent_id: job_intent_id,
                        wire_intent,
                        ..
                    } if job_intent_id == intent_id => Some(wire_intent.source_chain.clone()),
                    _ => None,
                })
            })
    }

    pub async fn source_intent(&self, intent_id: &str) -> Option<SourceIntentRecord> {
        self.snapshot
            .lock()
            .await
            .source_intents
            .get(intent_id)
            .cloned()
    }

    pub async fn upsert(&self, job: Job) -> Result<Job, String> {
        let mut snapshot = self.snapshot.lock().await;
        snapshot.jobs.insert(job.id.clone(), job.clone());
        persist_snapshot(&self.path, &snapshot)?;
        Ok(job)
    }

    pub async fn record_source_intent_submission(
        &self,
        intent_id: &str,
        source_chain: &str,
        metadata: &SourceIntentMetadata,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().await;
        let existing = snapshot.source_intents.get(intent_id).cloned();
        snapshot.source_intents.insert(
            intent_id.to_owned(),
            match existing {
                Some(mut record) => {
                    record.source_chain = source_chain.to_owned();
                    record.kind = metadata.kind.clone();
                    record.refund_asset = metadata.refund_asset.clone();
                    record.refundable_amount = metadata.refundable_amount.clone();
                    record.min_output_amount = metadata.min_output_amount.clone();
                    record
                }
                None => SourceIntentRecord {
                    intent_id: intent_id.to_owned(),
                    source_chain: source_chain.to_owned(),
                    kind: metadata.kind.clone(),
                    refund_asset: metadata.refund_asset.clone(),
                    refundable_amount: metadata.refundable_amount.clone(),
                    min_output_amount: metadata.min_output_amount.clone(),
                    status: SourceIntentStatus::Submitted,
                    dispatch_tx_hash: None,
                    dispatch_strategy: None,
                    outcome_reference: None,
                    result_asset_id: None,
                    result_amount: None,
                    failure_reason_hash: None,
                    refund_amount: "0".to_owned(),
                },
            },
        );
        persist_snapshot(&self.path, &snapshot)
    }

    pub async fn mark_source_intent_dispatched(
        &self,
        intent_id: &str,
        dispatch: Option<&SourceDispatchMetadata>,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().await;
        let record = snapshot
            .source_intents
            .get_mut(intent_id)
            .ok_or_else(|| format!("missing source intent record for {intent_id}"))?;
        record.status = SourceIntentStatus::Dispatched;
        record.dispatch_tx_hash = dispatch.map(|value| value.tx_hash.clone());
        record.dispatch_strategy = dispatch.and_then(|value| value.strategy.clone());
        persist_snapshot(&self.path, &snapshot)
    }

    pub async fn mark_source_intent_settled(
        &self,
        intent_id: &str,
        outcome_reference: &str,
        result_asset_id: &str,
        result_amount: &str,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().await;
        let record = snapshot
            .source_intents
            .get_mut(intent_id)
            .ok_or_else(|| format!("missing source intent record for {intent_id}"))?;
        record.status = SourceIntentStatus::Settled;
        record.outcome_reference = Some(outcome_reference.to_owned());
        record.result_asset_id = Some(result_asset_id.to_owned());
        record.result_amount = Some(result_amount.to_owned());
        record.failure_reason_hash = None;
        persist_snapshot(&self.path, &snapshot)
    }

    pub async fn mark_source_intent_failed(
        &self,
        intent_id: &str,
        outcome_reference: &str,
        failure_reason_hash: &str,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().await;
        let record = snapshot
            .source_intents
            .get_mut(intent_id)
            .ok_or_else(|| format!("missing source intent record for {intent_id}"))?;
        record.status = SourceIntentStatus::Failed;
        record.outcome_reference = Some(outcome_reference.to_owned());
        record.failure_reason_hash = Some(failure_reason_hash.to_owned());
        record.result_asset_id = None;
        record.result_amount = None;
        persist_snapshot(&self.path, &snapshot)
    }

    pub async fn mark_source_intent_refunded(
        &self,
        intent_id: &str,
        refund_amount: &str,
        refund_asset: Option<&str>,
    ) -> Result<(), String> {
        let mut snapshot = self.snapshot.lock().await;
        let record = snapshot
            .source_intents
            .get_mut(intent_id)
            .ok_or_else(|| format!("missing source intent record for {intent_id}"))?;
        record.status = SourceIntentStatus::Refunded;
        record.refund_amount = refund_amount.to_owned();
        if let Some(refund_asset) = refund_asset {
            record.refund_asset = refund_asset.to_owned();
        }
        persist_snapshot(&self.path, &snapshot)
    }
}

fn persist_snapshot(path: &Path, snapshot: &StoreSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create job store directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let raw = serde_json::to_string_pretty(snapshot)
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
