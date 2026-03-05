import { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'

export type ChatMessageType = 'user' | 'dj' | 'pattern' | 'error' | 'system'

export interface ChatMessage {
  id: string
  type: ChatMessageType
  ts: number
  text?: string
  code?: string
}

interface ChatProps {
  messages: ChatMessage[]
  onSend: (text: string) => Promise<void>
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function highlightStrudel(code: string): string {
  let html = escapeHtml(code)
  html = html.replace(/(\/\/.*)$/gm, '<span style="color:#8693a6;">$1</span>')
  html = html.replace(/("[^"]*"|'[^']*')/g, '<span style="color:#f4a261;">$1</span>')
  html = html.replace(/\b(setcpm|setcps|stack|xfade|slow|note|s|hush|gain|room|delay|cutoff|lpf|lpq|attack|decay|sustain|release|begin|end|slice|chop|speed|every|sometimesBy|off|jux|rev|bank)\b/g, '<span style="color:#80ed99;">$1</span>')
  return html
}

function PatternCodeBlock({ code }: { code: string }) {
  const [visibleLength, setVisibleLength] = useState(0)

  useEffect(() => {
    setVisibleLength(0)
    const fullLength = code.length
    const durationMs = 400
    const stepMs = 16
    const step = Math.max(1, Math.ceil((fullLength * stepMs) / durationMs))

    const timer = window.setInterval(() => {
      setVisibleLength((prev) => {
        const next = prev + step
        if (next >= fullLength) {
          window.clearInterval(timer)
          return fullLength
        }
        return next
      })
    }, stepMs)

    return () => window.clearInterval(timer)
  }, [code])

  const snippet = code.slice(0, visibleLength)

  return (
    <pre
      style={{ margin: 0, padding: 10, borderRadius: 10, background: '#121a24', overflowX: 'auto', lineHeight: 1.45 }}
      dangerouslySetInnerHTML={{ __html: highlightStrudel(snippet) }}
    />
  )
}

export default function Chat({ messages, onSend }: ChatProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)

  const recent = useMemo(() => messages.slice(-160), [messages])

  useEffect(() => {
    if (!autoScroll) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [recent, autoScroll])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setAutoScroll(distanceFromBottom < 80)
  }

  async function submit(): Promise<void> {
    const payload = text.trim()
    if (!payload || sending) return

    setSending(true)
    try {
      await onSend(payload)
      setText('')
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <section style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 12, minHeight: 0 }}>
      <div
        ref={listRef}
        onScroll={onScroll}
        style={{ overflowY: 'auto', border: '1px solid #273445', borderRadius: 12, padding: 12, background: '#0b1118', minHeight: 0 }}
      >
        {recent.length === 0 ? <p style={{ opacity: 0.7, margin: 0 }}>No messages yet.</p> : null}

        {recent.map((msg) => {
          if (msg.type === 'pattern') {
            return (
              <div key={msg.id} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#8da2b8', marginBottom: 4 }}>PATTERN • {formatTime(msg.ts)}</div>
                <PatternCodeBlock code={msg.code ?? msg.text ?? ''} />
              </div>
            )
          }

          if (msg.type === 'error') {
            return (
              <div key={msg.id} style={{ marginBottom: 12, border: '1px solid #8b2d2d', background: '#3b1116', borderRadius: 10, padding: 10, color: '#ffd6d6' }}>
                <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>ERROR • {formatTime(msg.ts)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
              </div>
            )
          }

          if (msg.type === 'system') {
            return (
              <div key={msg.id} style={{ marginBottom: 10, fontSize: 12, color: '#8da2b8' }}>
                {msg.text}
              </div>
            )
          }

          const isUser = msg.type === 'user'

          return (
            <div key={msg.id} style={{ marginBottom: 10, display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '82%',
                borderRadius: 10,
                padding: '8px 10px',
                background: isUser ? '#1c3556' : '#1a252f',
                border: '1px solid #2a3f55'
              }}>
                <div style={{ fontSize: 11, color: '#8da2b8', marginBottom: 3 }}>
                  {isUser ? 'you' : 'Heiwa'} • {formatTime(msg.ts)}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="Talk to Heiwa... more bass, drop it, go darker"
          style={{
            resize: 'vertical',
            minHeight: 72,
            borderRadius: 10,
            border: '1px solid #273445',
            background: '#0b1118',
            color: '#e7edf5',
            padding: 10,
            fontSize: 15
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#8da2b8' }}>Enter to send · Shift+Enter newline</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending}
            style={{
              border: 0,
              borderRadius: 10,
              padding: '9px 14px',
              background: '#2a9d8f',
              color: '#06241f',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  )
}
