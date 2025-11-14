import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line, Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
} from 'chart.js'
import zoomPlugin from 'chartjs-plugin-zoom'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Title, Tooltip, Legend, TimeScale, zoomPlugin)

const WS_URL = (import.meta.env.VITE_WS_URL) || 'ws://localhost:4001/ws'
const API_URL = (import.meta.env.VITE_API_URL) || 'http://localhost:4000'

function useJwt() {
  const [token, setToken] = useState('')
  useEffect(() => {
    async function fetchToken() {
      const r = await fetch(`${API_URL}/token`)
      const j = await r.json()
      setToken(j.token)
    }
    fetchToken()
  }, [])
  return token
}

function useWs(token) {
  const [status, setStatus] = useState('connecting')
  const [snapshot, setSnapshot] = useState(null)
  const [delta, setDelta] = useState(null)
  const wsRef = useRef(null)
  const backoffRef = useRef(500)

  useEffect(() => {
    if (!token) return
    let stopped = false
    function connect() {
      const url = `${WS_URL}${WS_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => {
        setStatus('open')
        backoffRef.current = 500
        ws.send(JSON.stringify({ type: 'subscribe', topic: 'dashboard:global' }))
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'agg_snapshot') setSnapshot(msg.data)
          if (msg.type === 'agg_delta') setDelta(msg.data)
        } catch {}
      }
      ws.onclose = () => {
        setStatus('closed')
        if (stopped) return
        const t = setTimeout(connect, backoffRef.current)
        backoffRef.current = Math.min(backoffRef.current * 2, 10000)
        return () => clearTimeout(t)
      }
      ws.onerror = () => {
        try { ws.close() } catch {}
      }
    }
    connect()
    return () => { stopped = true; try { wsRef.current && wsRef.current.close() } catch {} }
  }, [token])

  return { status, snapshot, delta }
}

function coalesce(base, delta) {
  if (!base) return delta
  const out = { ...base }
  for (const k of Object.keys(delta || {})) out[k] = delta[k]
  return out
}

export default function App() {
  const token = useJwt()
  const { status, snapshot, delta } = useWs(token)
  const agg = useMemo(() => coalesce(snapshot, delta), [snapshot, delta])

  const [history, setHistory] = useState([])
  const [paused, setPaused] = useState(false)
  const [range, setRange] = useState(120) // seconds
  useEffect(() => {
    if (!agg || paused) return
    const now = Date.now()
    setHistory((prev) => {
      const next = [...prev, { t: now, agg }]
      return next.slice(-Math.max(10, range))
    })
  }, [agg, paused, range])

  function resetZoomAll() {
    try { chartRefs.current.forEach(c => c && c.resetZoom && c.resetZoom()) } catch {}
  }

  const chartRefs = useRef([])
  chartRefs.current = []
  const setChartRef = (el) => { if (el && !chartRefs.current.includes(el)) chartRefs.current.push(el) }

  const times = history.map(h => new Date(h.t).toLocaleTimeString())
  const counts1s = history.map(h => h.agg?.['1s']?.count || 0)
  const counts5s = history.map(h => h.agg?.['5s']?.count || 0)
  const counts60s = history.map(h => h.agg?.['60s']?.count || 0)
  const uniques = history.map(h => h.agg?.['60s']?.uniques || 0)
  const errors = history.map(h => h.agg?.['60s']?.errors || 0)

  const zoomOptions = { zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }, pan: { enabled: true, mode: 'x' }, limits: { x: { min: 0 } } }
  const baseChartOpts = { animation: false, responsive: true, scales: { y: { beginAtZero: true } }, plugins: { legend: { display: true }, zoom: zoomOptions } }

  const latest = history[history.length - 1]?.agg
  const stat = (label, value, tone) => (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color: tone }}>{value}</div>
    </div>
  )

  return (
    <div className="app">
      <div className="header">
        <div className="brand"><span className="dot"></span> Real-Time Analytics</div>
        <div className="controls">
          <span className="status"><span className={`dot ${status==='open'?'ok':status==='closed'?'err':'warn'}`}></span>{status}</span>
          <select className="select" value={range} onChange={e=>setRange(Number(e.target.value))}>
            <option value={60}>Last 1 min</option>
            <option value={120}>Last 2 min</option>
            <option value={300}>Last 5 min</option>
          </select>
          <button className="btn ghost" onClick={()=>setPaused(p=>!p)}>{paused?'Resume':'Pause'}</button>
          <button className="btn" onClick={()=>setHistory([])}>Clear</button>
          <button className="btn primary" onClick={resetZoomAll}>Reset Zoom</button>
        </div>
      </div>

      <div className="grid">
        <div>
          <div className="stats">
            {stat('Events (1s)', latest?.['1s']?.count ?? 0, '#3b82f6')}
            {stat('Events (5s)', latest?.['5s']?.count ?? 0, '#10b981')}
            {stat('Active Users (60s)', latest?.['60s']?.uniques ?? 0, '#f59e0b')}
            {stat('Errors (60s)', latest?.['60s']?.errors ?? 0, '#ef4444')}
          </div>

          <div className="charts">
            <div className="panel">
              <h4>Events/sec (1s)</h4>
              <Line ref={setChartRef} data={{ labels: times, datasets: [{ label: 'events', data: counts1s, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.2)' }] }} options={baseChartOpts} />
            </div>
            <div className="panel">
              <h4>Events (5s vs 60s)</h4>
              <Line ref={setChartRef} data={{ labels: times, datasets: [ { label: '5s', data: counts5s, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.2)' }, { label: '60s', data: counts60s, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.2)' } ] }} options={baseChartOpts} />
            </div>
            <div className="panel">
              <h4>Active Users (60s)</h4>
              <Bar ref={setChartRef} data={{ labels: times, datasets: [{ label: 'uniques', data: uniques, backgroundColor: '#f59e0b' }] }} options={baseChartOpts} />
            </div>
            <div className="panel">
              <h4>Error Rate (60s)</h4>
              <Line ref={setChartRef} data={{ labels: times, datasets: [{ label: 'errors', data: errors, borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.2)' }] }} options={baseChartOpts} />
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <TopRoutes agg={agg} />
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <SendDemo token={token} />
          </div>
        </div>
      </div>

      {!agg && <div className="footer">Loading live data…</div>}
    </div>
  )
}

function TopRoutes({ agg }) {
  const routes = agg?.['60s']?.routes || []
  return (
    <div>
      <h4>Top Routes (60s)</h4>
      <ul className="list">
        {routes.length === 0 && <li style={{ color: '#94a3b8' }}>No data yet</li>}
        {routes.map(([r,c]) => (
          <li key={r}><span>{r}</span><span>{c}</span></li>
        ))}
      </ul>
    </div>
  )
}

function SendDemo({ token }) {
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(25)
  async function send() {
    setBusy(true)
    try {
      const now = Date.now()
      const events = Array.from({ length: count }).map((_, i) => ({
        eventId: crypto.randomUUID(),
        ts: now,
        userId: `u-${(i % 7) + 1}`,
        sessionId: `s-${(i % 13) + 1}`,
        route: ['/', '/pricing', '/dashboard', '/login'][i % 4],
        action: ['view', 'click', 'error'][i % 3],
        metadata: { i }
      }))
      await fetch(`${API_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(events)
      })
    } finally { setBusy(false) }
  }
  return (
    <div>
      <h4>Send Synthetic Events</h4>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="select" type="number" value={count} onChange={e => setCount(Number(e.target.value || 0))} min={1} max={500} />
        <button className="btn primary" onClick={send} disabled={busy || !token}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  )
}


