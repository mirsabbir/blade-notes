import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { App } from './App'
import { UpdateBanner } from './Updates'
import { completeSignIn, isSignedIn, loadConfig, signIn } from './auth'
import { checkClock, load, sync, useStore } from './store'

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

  // Keep devices in step: every 10 s while visible, and at once when the window gets
  // focus (switching from the desktop app to a visible browser tab fires no visibilitychange),
  // when the tab comes back and when the network returns.
  useEffect(() => {
    if (phase !== 'ready') return
    // The clock check redraws dates when the day or the device's zone has changed (travel).
    const tick = () => {
      checkClock()
      if (document.visibilityState === 'visible') void sync()
    }
    checkClock()
    const id = setInterval(tick, 10_000)
    const events = ['focus', 'online'] as const
    events.forEach((e) => window.addEventListener(e, tick))
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      events.forEach((e) => window.removeEventListener(e, tick))
      document.removeEventListener('visibilitychange', tick)
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
      <UpdateBanner />
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
