import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import type { ExposedViraApi } from '../../preload/index'

declare global {
  interface Window {
    api: ExposedViraApi
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
