import { useEffect, useId, useState } from 'react'
import { Bot, Check, CheckCircle2, Copy, ShieldCheck, ZapOff } from 'lucide-react'
import Modal from './Modal'
import { m } from '../i18n'
import { isDesktop, detectAiAssistants, linkClaudeDesktop, unlinkClaudeDesktop, type AiAssistantsReport } from '../native'
import type { Settings } from './SettingsModal'

interface Props {
  settings: Settings
  onUpdateSettings: (s: Partial<Settings>) => void
  onClose: () => void
}

export default function AssistantSetupModal({ settings, onUpdateSettings, onClose }: Props) {
  const titleId = useId()
  const [report, setReport] = useState<AiAssistantsReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const [linking, setLinking] = useState(false)
  const [linkedNotice, setLinkedNotice] = useState('')
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [aiDisabled, setAiDisabled] = useState(settings.aiDisabled ?? false)

  useEffect(() => {
    let active = true
    detectAiAssistants()
      .then((rep) => {
        if (active) {
          setReport(rep)
          setScanning(false)
        }
      })
      .catch(() => {
        if (active) setScanning(false)
      })
    return () => {
      active = false
    }
  }, [])

  const handleToggleAiDisabled = (disabled: boolean) => {
    setAiDisabled(disabled)
    onUpdateSettings({
      aiDisabled: disabled,
      aiEnabled: disabled ? false : settings.aiEnabled,
    })
  }

  const handleLinkClaude = async () => {
    if (!isDesktop) {
      void navigator.clipboard.writeText('npx -y openquire mcp setup')
      setCopiedCmd(true)
      setTimeout(() => setCopiedCmd(false), 3000)
      return
    }

    setLinking(true)
    try {
      await linkClaudeDesktop()
      setLinkedNotice('Successfully linked OpenQuire MCP! Restart Claude Desktop to use.')
      const rep = await detectAiAssistants()
      setReport(rep)
    } catch (err) {
      setLinkedNotice(`Failed to link automatically: ${String(err)}`)
    } finally {
      setLinking(false)
    }
  }

  const handleUnlinkClaude = async () => {
    if (!isDesktop) return
    setLinking(true)
    try {
      await unlinkClaudeDesktop()
      setLinkedNotice('Disconnected OpenQuire from Claude Desktop.')
      const rep = await detectAiAssistants()
      setReport(rep)
    } catch (err) {
      setLinkedNotice(`Failed to disconnect: ${String(err)}`)
    } finally {
      setLinking(false)
    }
  }

  const handleFinish = () => {
    onClose()
  }

  const claude = report?.claude_desktop
  const chatgpt = report?.chatgpt_desktop
  const cursor = report?.cursor

  return (
    <Modal className="assistant-setup-modal" labelledBy={titleId} onClose={handleFinish}>
      <div style={{ padding: '4px 8px 12px 8px', maxWidth: 580 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 52,
              height: 52,
              borderRadius: 12,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              marginBottom: 12,
              color: 'var(--accent)',
            }}
          >
            <ShieldCheck size={32} />
          </div>
          <h2 id={titleId} style={{ margin: '0 0 6px 0', fontSize: '1.45rem', fontWeight: 600 }}>{m.settings.openOnboardingWizard}</h2>
          <p style={{ margin: '0 0 10px 0', color: 'var(--text-muted)', fontSize: '0.92rem' }}>{m.onboarding.subtitle}</p>
          <span
            style={{
              display: 'inline-block',
              padding: '3px 10px',
              borderRadius: 20,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              fontSize: '0.78rem',
              color: 'var(--accent)',
              fontWeight: 500,
            }}
          >
            {m.onboarding.privacyBadge}
          </span>
        </div>

        {/* Option: Disable All AI Features */}
        <div
          style={{
            padding: 14,
            borderRadius: 8,
            border: `1px solid ${aiDisabled ? 'var(--accent)' : 'var(--border)'}`,
            background: aiDisabled ? 'var(--panel-alt, var(--panel))' : 'var(--bg)',
            marginBottom: 18,
            transition: 'all 0.15s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <ZapOff size={18} style={{ color: aiDisabled ? 'var(--accent)' : 'var(--text-muted)' }} />
                <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{m.onboarding.disableAiTitle}</span>
              </div>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {m.onboarding.disableAiDesc}
              </p>
            </div>
            <label className="toggle-switch" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', marginTop: 2 }}>
              <input
                type="checkbox"
                aria-label={m.onboarding.disableAiTitle}
                checked={aiDisabled}
                onChange={(e) => handleToggleAiDisabled(e.target.checked)}
                style={{ width: 18, height: 18, cursor: 'pointer' }}
              />
            </label>
          </div>
          {aiDisabled && (
            <div style={{ marginTop: 10, fontSize: '0.82rem', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
              <Check size={14} />
              <span>{m.onboarding.aiDisabledActive}</span>
            </div>
          )}
        </div>

        {/* AI & Assistant Integrations Section (Hidden or dimmed if AI is disabled) */}
        {!aiDisabled && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ margin: '0 0 2px 0', fontSize: '1rem', fontWeight: 600 }}>{m.onboarding.aiStepTitle}</h3>
              <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-muted)' }}>{m.onboarding.aiStepDesc}</p>
            </div>

            {scanning ? (
              <div style={{ padding: 16, textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {m.onboarding.detectingAssistants}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Claude Desktop Card */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--panel)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Bot size={18} style={{ color: 'var(--accent)' }} />
                      <span style={{ fontWeight: 600, fontSize: '0.92rem' }}>Claude Desktop</span>
                    </div>
                    {claude?.linked ? (
                      <span style={{ fontSize: '0.75rem', color: '#2e7d32', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <CheckCircle2 size={13} />
                        {m.onboarding.connectedBadge}
                      </span>
                    ) : claude?.installed ? (
                      <span style={{ fontSize: '0.75rem', color: 'var(--accent)', fontWeight: 500, padding: '2px 6px', background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)' }}>
                        Detected
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Available</span>
                    )}
                  </div>

                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>
                    {m.onboarding.connectClaudeDesc}
                  </p>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                    {isDesktop ? (
                      claude?.linked ? (
                        <button
                          type="button"
                          disabled={linking}
                          onClick={handleUnlinkClaude}
                          style={{ padding: '4px 10px', fontSize: '0.8rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}
                        >
                          {m.onboarding.unlinkBtn}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cta"
                          disabled={linking}
                          onClick={handleLinkClaude}
                          style={{ padding: '5px 12px', fontSize: '0.82rem', cursor: 'pointer' }}
                        >
                          {linking ? m.onboarding.connecting : m.onboarding.connectBtn}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={handleLinkClaude}
                        style={{ padding: '4px 10px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                      >
                        <Copy size={13} />
                        <span>{copiedCmd ? 'Command Copied!' : 'Copy Setup Command (npx)'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* ChatGPT Desktop Card */}
                {chatgpt?.installed && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--panel)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>ChatGPT Desktop</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{m.onboarding.openProtocolNote}</div>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--accent)', padding: '2px 6px', background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)' }}>
                      Detected
                    </span>
                  </div>
                )}

                {/* Cursor Card */}
                {cursor?.installed && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--panel)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Cursor Editor</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Code editor with native MCP protocol</div>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--accent)', padding: '2px 6px', background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)' }}>
                      {cursor.linked ? 'Linked ✓' : 'Detected'}
                    </span>
                  </div>
                )}
              </div>
            )}

            {linkedNotice && (
              <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 4, background: 'var(--panel)', border: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--accent)' }}>
                {linkedNotice}
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16, textAlign: 'center' }}>
          {m.onboarding.manageLaterHint}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            type="button"
            className="cta"
            onClick={handleFinish}
            style={{ width: '100%', padding: '8px 16px', fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer' }}
          >
            {m.onboarding.getStarted}
          </button>
        </div>
      </div>
    </Modal>
  )
}
