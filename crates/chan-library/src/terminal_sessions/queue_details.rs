//! Read-only, bounded previews of the terminal's pending logical messages.

use serde::Serialize;

use super::{MessagePart, Session};

/// One logical message still waiting in a terminal's input queue.
#[derive(Debug, Serialize)]
pub struct QueuedMessagePreview {
    /// Original message text, bounded to 4096 UTF-8 bytes, without submit chords.
    pub text: String,
    /// `cs_write` or `rich_prompt`, identifying how the message entered the queue.
    pub source: &'static str,
    /// Rich Prompt identity, absent for control-socket writes.
    pub prompt_id: Option<String>,
    /// The body has reached the PTY and only its separate submit chord remains.
    pub awaiting_submit: bool,
}

impl Session {
    pub(super) fn queued_message_previews(&self) -> Vec<QueuedMessagePreview> {
        let queue = self
            .write_queue
            .lock()
            .expect("terminal write queue poisoned");
        let mut previews = Vec::new();
        let mut previous_was_body = false;
        for message in queue.iter() {
            // A split body + chord is one logical message. A leading chord
            // means its body has already drained and is no longer retained.
            if message.part == MessagePart::Chord && previous_was_body {
                previous_was_body = false;
                continue;
            }
            previous_was_body = message.part == MessagePart::Body;
            previews.push(QueuedMessagePreview {
                text: message.data.clone(),
                source: message.source.as_str(),
                prompt_id: message.prompt_id.clone(),
                awaiting_submit: message.part == MessagePart::Chord,
            });
        }
        previews
    }
}

#[cfg(test)]
mod tests {
    use crate::terminal_sessions::tests::{built_in_submit, test_session_with_ring};
    use chan_shell::SubmitAgent;

    #[test]
    fn previews_keep_fifo_order_without_counting_submit_chords_twice() {
        let session = test_session_with_ring(1024);
        session.enqueue_cs_write("first".into(), None);
        session.enqueue_prompt(
            "second".into(),
            Some(built_in_submit(SubmitAgent::Gemini)),
            Some("p".into()),
        );
        let messages = session.queued_message_previews();
        assert_eq!(
            messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(messages.len(), session.queue_depth());
        assert_eq!(messages[0].source, "cs_write");
        assert_eq!(messages[1].source, "rich_prompt");
        assert_eq!(messages[1].prompt_id.as_deref(), Some("p"));
        assert!(!messages[1].awaiting_submit);
        assert!(session.cancel_prompt("p"));
        assert_eq!(session.queued_message_previews().len(), 1);
    }

    #[test]
    fn previews_mark_a_message_whose_body_already_drained() {
        let session = test_session_with_ring(1024);
        session.enqueue_prompt(
            "body".into(),
            Some(built_in_submit(SubmitAgent::Gemini)),
            Some("p".into()),
        );
        session.write_queue.lock().unwrap().pop_front();
        let messages = session.queued_message_previews();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].awaiting_submit);
        assert!(messages[0].text.is_empty());
    }

    #[test]
    fn previews_preserve_multibyte_text_without_mutating_the_queue() {
        let session = test_session_with_ring(1024);
        let text = "€".repeat(1365);
        assert_eq!(session.enqueue_cs_write(text.clone(), None), Some(1));
        let messages = session.queued_message_previews();
        assert_eq!(messages[0].text, text);
        assert_eq!(messages[0].text.len(), 4095);
        assert_eq!(session.write_queue.lock().unwrap()[0].data, text);
    }
}
