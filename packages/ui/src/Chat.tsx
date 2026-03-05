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
    <section style={{ display: 'grid', gridTemplateRows: '1fr auto', gap: 0, height: '100%', minHeight: 0 }}>
      <div
        ref={listRef}
        onScroll={onScroll}
        style={{
          overflowY: 'auto',
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minHeight: 0,
          background: 'rgba(5, 8, 12, 0.2)'
        }}
      >
        {recent.length === 0 ? (
          <div style={{ opacity: 0.4, textAlign: 'center', marginTop: 40, fontSize: 14 }}>
            No activity yet. Start the set to see Heiwa's selections.
          </div>
        ) : null}

        {recent.map((msg) => {
          if (msg.type === 'pattern') {
            return (
              <div key={msg.id} style={{ alignSelf: 'stretch', marginBottom: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#94abc7', marginBottom: 8, letterSpacing: '0.05em', opacity: 0.8 }}>
                  PATTERN • {formatTime(msg.ts)}
                </div>
                <div style={{
                  borderRadius: 12,
                  overflow: 'hidden',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.2)'
                }}>
                  <PatternCodeBlock code={msg.code ?? msg.text ?? ''} />
                </div>
              </div>
            )
          }

          if (msg.type === 'error') {
            return (
              <div key={msg.id} style={{
                alignSelf: 'stretch',
                border: '1px solid rgba(255, 92, 122, 0.2)',
                background: 'rgba(255, 92, 122, 0.05)',
                borderRadius: 12,
                padding: '12px 16px',
                color: '#ff99aa'
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.6, marginBottom: 6, letterSpacing: '0.05em' }}>
                  SYSTEM ERROR • {formatTime(msg.ts)}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5, fontFamily: 'ui-monospace, monospace' }}>{msg.text}</div>
              </div>
            )
          }

          if (msg.type === 'system') {
            return (
              <div key={msg.id} style={{ alignSelf: 'center', margin: '4px 0', fontSize: 12, color: '#667c94', fontWeight: 500 }}>
                {msg.text}
              </div>
            )
          }

          const isUser = msg.type === 'user'

          return (
            <div key={msg.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '85%',
                borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                padding: '12px 16px',
                background: isUser ? '#1f416b' : 'rgba(255, 255, 255, 0.04)',
                border: isUser ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(255, 255, 255, 0.05)',
                boxShadow: isUser ? '0 4px 12px rgba(0, 0, 0, 0.15)' : 'none'
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: isUser ? '#90caf9' : '#94abc7', marginBottom: 6, letterSpacing: '0.05em' }}>
                  {isUser ? 'YOU' : 'HEIWA'} • {formatTime(msg.ts)}
                </div>
                <div style={{ fontSize: 15, lineHeight: 1.5, color: '#e7edf5' }}>{msg.text}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{
        padding: 16,
        background: 'rgba(5, 8, 12, 0.4)',
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        display: 'grid',
        gap: 12
      }}>
        <div style={{ position: 'relative' }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Direct the performance..."
            style={{
              width: '100%',
              resize: 'none',
              minHeight: 52,
              borderRadius: 14,
              border: '1px solid rgba(255, 255, 255, 0.1)',
              background: 'rgba(0, 0, 0, 0.3)',
              color: '#fff',
              padding: '14px 100px 14px 16px',
              fontSize: 15,
              fontWeight: 500,
              boxSizing: 'border-box',
              outline: 'none',
              transition: 'all 200ms ease'
            }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            style={{
              position: 'absolute',
              right: 8,
              top: 8,
              bottom: 8,
              border: 0,
              borderRadius: 10,
              padding: '0 16px',
              background: sending || !text.trim() ? 'rgba(255, 255, 255, 0.05)' : '#3ddc97',
              color: sending || !text.trim() ? '#667c94' : '#050a08',
              fontWeight: 700,
              fontSize: 13,
              cursor: sending || !text.trim() ? 'default' : 'pointer',
              transition: 'all 200ms ease'
            }}
          >
            {sending ? '...' : 'SEND'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', opacity: 0.3, fontSize: 11, fontWeight: 600, letterSpacing: '0.02em' }}>
          Press Enter to send
        </div>
      </div>
    </section>
  )
}
