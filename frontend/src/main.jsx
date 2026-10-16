import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import { initTheme } from './shared/theme.js'

// La elección de tema guardada se aplica antes del primer render (sin parpadeo).
initTheme()

ReactDOM.createRoot(document.getElementById('root')).render(
  // StrictMode permite comprobar que restauración y lecturas no se duplican.
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
