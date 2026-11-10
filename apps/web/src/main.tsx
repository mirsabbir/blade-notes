import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { App } from './App'
import { completeSignIn, isSignedIn, loadConfig, signIn } from './auth'
import { load, sync, useStore } from './store'

function Root() {
  const [phase, setPhase] = useState<'starting' | 'signed-out' | 'ready' | 'failed'>('starting')
  const [error, setError] = useState('')
  const { status, loaded } = useStore()

  useEffect(() => {
    ;(async () => {
      try {
        await loadConfig()
        await completeSignIn()
        await load()
        if (!isSignedIn()) return setPhase('signed-out')
        setPhase('ready')
        void sync()
      } catch (err) {
        setError((err as Error).message)
        setPhase('failed')
      }
    })()
  }, [])

  // Keep devices in step: every 30 s, when the tab comes back, and when the network returns.
  useEffect(() => {
    if (phase !== 'ready') return
    const tick = () => document.visibilityState === 'visible' && void sync()
    const id = setInterval(tick, 30_000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('online', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('online', tick)
    }
  }, [phase])

  if (phase === 'failed') return <Splash title="Could not start" text={error} />
  if (phase === 'signed-out' || (phase === 'ready' && status === 'signed-out' && !loaded))
    return <Splash title="Blade Notes" text="Your notes, folder by folder." action={{ label: 'Sign in', run: () => void signIn() }} />
  if (phase === 'starting' || !loaded) return <Splash title="Blade Notes" text="Loading…" />
  return (
    <>
      {status === 'signed-out' && (
        <div className="banner" role="status">
          Your sign-in expired. Changes are kept on this device.
          <button className="btn" onClick={() => void signIn()}>Sign in again</button>
        </div>
      )}
      <App />
    </>
  )
}

function Splash({ title, text, action }: { title: string; text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="splash">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>{title}</h1>
      <p>{text}</p>
      {action && <button className="btn primary" onClick={action.run}>{action.label}</button>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
