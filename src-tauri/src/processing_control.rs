use crate::domain::{AppError, Result};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Clone, Default)]
pub struct Owner(Arc<Mutex<Option<Arc<Operation>>>>);
struct Operation {
    meeting_id: String,
    run_id: Option<String>,
    cancel: Arc<AtomicBool>,
}
pub struct Guard {
    owner: Owner,
    operation: Arc<Operation>,
}
fn cancelled() -> AppError {
    AppError::new(
        "stt_cancelled",
        "Processing was cancelled. Previous results were kept.",
    )
}
impl Owner {
    pub fn is_idle(&self) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).is_none()
    }
    pub fn begin(&self, meeting_id: &str) -> Result<Guard> {
        self.begin_operation(meeting_id, None)
    }
    pub fn begin_session(&self, meeting_id: &str, run_id: &str) -> Result<Guard> {
        self.begin_operation(meeting_id, Some(run_id.into()))
    }
    fn begin_operation(&self, meeting_id: &str, run_id: Option<String>) -> Result<Guard> {
        let mut active = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if active.is_some() {
            return Err(AppError::new(
                "processing_busy",
                "Another processing operation is running.",
            ));
        }
        let operation = Arc::new(Operation {
            meeting_id: meeting_id.into(),
            run_id,
            cancel: Arc::new(AtomicBool::new(false)),
        });
        *active = Some(operation.clone());
        Ok(Guard {
            owner: self.clone(),
            operation,
        })
    }
    #[cfg(test)]
    pub fn cancel(&self, meeting_id: &str) -> bool {
        self.cancel_matching(Some(meeting_id))
    }
    pub fn cancel_session_with<T>(
        &self,
        meeting_id: &str,
        apply: impl FnOnce() -> Result<(T, String)>,
    ) -> Result<T> {
        let active = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let (result, run_id) = apply()?;
        if let Some(operation) = active.as_ref().filter(|operation| {
            operation.meeting_id == meeting_id
                && operation.run_id.as_deref() == Some(run_id.as_str())
        }) {
            operation.cancel.store(true, Ordering::SeqCst);
        }
        Ok(result)
    }
    pub fn cancel_active(&self) -> bool {
        self.cancel_matching(None)
    }
    fn cancel_matching(&self, meeting_id: Option<&str>) -> bool {
        let active = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(operation) = active
            .as_ref()
            .filter(|op| meeting_id.is_none_or(|id| id == op.meeting_id))
        {
            operation.cancel.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}
impl Guard {
    pub fn cancel(&self) -> &AtomicBool {
        &self.operation.cancel
    }
    pub fn cancellation_handle(&self) -> Arc<AtomicBool> {
        self.operation.cancel.clone()
    }
    pub fn finish<T>(&self, publish: impl FnOnce() -> Result<T>) -> Result<T> {
        let active = self.owner.0.lock().unwrap_or_else(|p| p.into_inner());
        if self.cancel().load(Ordering::SeqCst)
            || !active
                .as_ref()
                .is_some_and(|op| Arc::ptr_eq(op, &self.operation))
        {
            return Err(cancelled());
        }
        publish()
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let mut active = self.owner.0.lock().unwrap_or_else(|p| p.into_inner());
        if active
            .as_ref()
            .is_some_and(|op| Arc::ptr_eq(op, &self.operation))
        {
            *active = None;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_cancellation_requires_valid_authorization_and_exact_run() {
        let owner = Owner::default();
        let guard = owner.begin_session("meeting", "new-run").unwrap();
        assert_eq!(
            owner
                .cancel_session_with::<()>("meeting", || Err(AppError::new("conflict", "Changed")))
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(
            guard.finish(|| Ok("still running")).unwrap(),
            "still running"
        );
        owner
            .cancel_session_with("meeting", || Ok(((), "old-run".into())))
            .unwrap();
        assert!(!guard.cancel().load(Ordering::SeqCst));
        owner
            .cancel_session_with("other-meeting", || Ok(((), "new-run".into())))
            .unwrap();
        assert!(!guard.cancel().load(Ordering::SeqCst));
        owner
            .cancel_session_with("meeting", || Ok(((), "new-run".into())))
            .unwrap();
        assert_eq!(guard.finish(|| Ok(())).unwrap_err().code, "stt_cancelled");
        drop(guard);
        let manual = owner.begin("meeting").unwrap();
        owner
            .cancel_session_with("meeting", || Ok(((), "new-run".into())))
            .unwrap();
        assert_eq!(
            manual.finish(|| Ok("manual result")).unwrap(),
            "manual result"
        );
    }

    #[test]
    fn cancellation_and_publication_are_exclusive_and_meeting_scoped() {
        let owner = Owner::default();
        assert!(owner.is_idle());
        let guard = owner.begin("one").unwrap();
        assert!(!owner.is_idle());
        assert!(owner.begin("two").is_err());
        assert!(!owner.cancel("two"));
        assert!(owner.cancel("one"));
        let mut saved = "old";
        assert_eq!(
            guard
                .finish(|| {
                    saved = "new";
                    Ok(())
                })
                .unwrap_err()
                .code,
            "stt_cancelled"
        );
        assert_eq!(saved, "old");
        drop(guard);
        let guard = owner.begin("two").unwrap();
        guard
            .finish(|| {
                saved = "complete";
                Ok(())
            })
            .unwrap();
        assert_eq!(saved, "complete");
        drop(guard);
        assert!(!owner.cancel_active());
        let next = owner.begin("three").unwrap();
        let handle = next.cancellation_handle();
        handle.store(true, Ordering::SeqCst);
        assert_eq!(
            next.finish(|| Ok("forbidden")).unwrap_err().code,
            "stt_cancelled"
        );
    }
    #[test]
    fn publication_gate_orders_concurrent_cancellation() {
        let owner = Owner::default();
        let guard = owner.begin("one").unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (cancelled_tx, cancelled_rx) = std::sync::mpsc::channel();
        let publication = std::thread::spawn(move || {
            let saved = guard
                .finish(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok("saved")
                })
                .unwrap();
            cancelled_rx.recv().unwrap();
            (
                saved,
                guard.finish(|| Ok("late replacement")).unwrap_err().code,
            )
        });
        entered_rx.recv().unwrap();
        let cancel = std::thread::spawn(move || owner.cancel_active());
        release_tx.send(()).unwrap();
        assert!(cancel.join().unwrap());
        cancelled_tx.send(()).unwrap();
        assert_eq!(publication.join().unwrap(), ("saved", "stt_cancelled"));
    }
}
