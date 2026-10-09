"use client";

import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { CHAT_MAX_LENGTH, type ChatMessage } from "../../shared/protocol";

/** Table talk, and the table's own announcements in the same column. */
export function Chat({ messages, myId, onSend }: { messages: ChatMessage[]; myId: string | null; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  // Stick to the newest message unless the reader has scrolled up to look back.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }, [messages]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="chat">
      <ol className="chat-log" ref={listRef} aria-live="polite" aria-label="Table chat">
        {messages.map((m) =>
          m.name === null ? (
            <li key={m.id} className="chat-line is-system">
              {m.text}
            </li>
          ) : (
            <li key={m.id} className="chat-line">
              <b>{m.playerId === myId ? "You" : m.name}</b> {m.text}
            </li>
          ),
        )}
      </ol>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={CHAT_MAX_LENGTH}
          placeholder="Say something"
          aria-label="Message the table"
          autoComplete="off"
        />
        <button className="btn" type="submit" aria-label="Send" disabled={!text.trim()} style={{ height: 38, padding: "0 12px" }}>
          <SendHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
