import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installAuthFetch } from './lib/authToken'
import './index.css'

// M2: every same-origin /api request carries the signed role token.
// Installed before the app tree mounts so no early fetch escapes it.
installAuthFetch()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
