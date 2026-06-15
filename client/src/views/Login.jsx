import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Ошибка входа');
      onLogin(data.token, { shop_name: data.shop_name, vision_ready: data.vision_ready });
    } catch (err) {
      setError(err.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">✂️</div>
        <h1>Расчёт зарплаты</h1>
        <p className="muted">Введите PIN-код</p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          className="pin-input"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn btn-primary btn-big" disabled={busy}>
          {busy ? 'Проверяю…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
